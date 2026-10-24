package perfdigest

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

var inheritedEnvKeys = map[string]bool{
	"PATH":                true,
	"HOME":                true,
	"USER":                true,
	"LOGNAME":             true,
	"SHELL":               true,
	"TMPDIR":              true,
	"TMP":                 true,
	"TEMP":                true,
	"LANG":                true,
	"TERM":                true,
	"COLORTERM":           true,
	"CODEX_HOME":          true,
	"XDG_CONFIG_HOME":     true,
	"XDG_CACHE_HOME":      true,
	"SYSTEMROOT":          true,
	"SystemRoot":          true,
	"WINDIR":              true,
	"COMSPEC":             true,
	"PATHEXT":             true,
	"APPDATA":             true,
	"LOCALAPPDATA":        true,
	"HTTP_PROXY":          true,
	"HTTPS_PROXY":         true,
	"NO_PROXY":            true,
	"http_proxy":          true,
	"https_proxy":         true,
	"no_proxy":            true,
	"SSL_CERT_FILE":       true,
	"SSL_CERT_DIR":        true,
	"NODE_EXTRA_CA_CERTS": true,
}

var (
	lcEnvPattern     = regexp.MustCompile(`^LC_[A-Z_]+$`)
	secretKeyPattern = regexp.MustCompile(`(?i)KEY|TOKEN|SECRET|PASSWORD`)
	skTokenPattern   = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}\b`)
	ghpTokenPattern  = regexp.MustCompile(`\bghp_[A-Za-z0-9]{20,}\b`)
	akiaPattern      = regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)
	bearerPattern    = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b`)
)

// OsEnvMap converts os.Environ() into a map[string]string.
func OsEnvMap() map[string]string {
	out := make(map[string]string)
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx >= 0 {
			out[entry[:idx]] = entry[idx+1:]
		}
	}
	return out
}

// ChildEnvironment returns an allowlisted environment map that prevents credential
// variables from leaking to child processes.
func ChildEnvironment(source map[string]string) map[string]string {
	if source == nil {
		source = OsEnvMap()
	}
	out := make(map[string]string)
	for k, v := range source {
		if inheritedEnvKeys[k] || lcEnvPattern.MatchString(k) {
			out[k] = v
		}
	}
	return out
}

// ChildEnvSlice formats ChildEnvironment(source) as a sorted KEY=VALUE slice for exec.Cmd.Env.
func ChildEnvSlice(source map[string]string) []string {
	m := ChildEnvironment(source)
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}

// Redact replaces secret environment values and known token patterns with [REDACTED].
func Redact(text string, sources ...map[string]string) string {
	var env map[string]string
	if len(sources) > 0 && sources[0] != nil {
		env = sources[0]
	} else {
		env = OsEnvMap()
	}
	result := text
	// Sort by value length descending so longer secrets are replaced before shorter substrings.
	type secretVal struct {
		val string
	}
	var secrets []secretVal
	for k, v := range env {
		if len(v) >= 6 && secretKeyPattern.MatchString(k) {
			secrets = append(secrets, secretVal{val: v})
		}
	}
	sort.Slice(secrets, func(i, j int) bool {
		return len(secrets[i].val) > len(secrets[j].val)
	})
	for _, s := range secrets {
		result = strings.ReplaceAll(result, s.val, "[REDACTED]")
	}
	result = skTokenPattern.ReplaceAllString(result, "[REDACTED]")
	result = ghpTokenPattern.ReplaceAllString(result, "[REDACTED]")
	result = akiaPattern.ReplaceAllString(result, "[REDACTED]")
	result = bearerPattern.ReplaceAllString(result, "Bearer [REDACTED]")
	return result
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// Executable locates an executable binary by explicit path or by searching PATH in env.
func Executable(name string, env map[string]string) (string, error) {
	if env == nil {
		env = OsEnvMap()
	}
	if filepath.IsAbs(name) || strings.ContainsRune(name, filepath.Separator) || strings.Contains(name, "/") || strings.Contains(name, "\\") {
		if isExecutableFile(name) {
			return name, nil
		}
		if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
			for _, ext := range windowsPathExtensions(env) {
				if isExecutableFile(name + ext) {
					return name + ext, nil
				}
			}
		}
		return "", fmt.Errorf("%s is not executable", name)
	}
	pathVal := env["PATH"]
	if pathVal == "" && runtime.GOOS == "windows" {
		pathVal = env["Path"]
	}
	exts := windowsPathExtensions(env)
	for _, dir := range filepath.SplitList(pathVal) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if isExecutableFile(candidate) {
			return candidate, nil
		}
		if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
			for _, ext := range exts {
				withExt := candidate + ext
				if isExecutableFile(withExt) {
					return withExt, nil
				}
			}
		}
	}
	return "", fmt.Errorf("%s is not on PATH", name)
}

func windowsPathExtensions(env map[string]string) []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	raw := env["PATHEXT"]
	if raw == "" {
		raw = ".COM;.EXE;.BAT;.CMD"
	}
	var out []string
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.HasPrefix(part, ".") {
			part = "." + part
		}
		out = append(out, part, strings.ToLower(part))
	}
	return out
}
