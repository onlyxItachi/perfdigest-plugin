package perfdigest

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const DefaultLocalEndpoint = "http://127.0.0.1:8137/v1/systemone"

var setupProviders = []string{"cloudflare", "local", "openai", "offline"}

type PluginConfiguration struct {
	Version       int    `json:"version"`
	Provider      string `json:"provider"`
	Endpoint      string `json:"endpoint,omitempty"`
	EnvFile       string `json:"envFile,omitempty"`
	DecisionModel string `json:"decisionModel,omitempty"`
}

type SetupDiagnostic struct {
	Check   string `json:"check"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type InitOptions struct {
	Workspace       string
	Provider        *string
	Endpoint        *string
	EnvFile         *string
	DecisionModel   *string
	Yes             bool
	CheckConnection bool
	Input           io.Reader
	InputIsTTY      bool
	Output          io.Writer
	OutputIsTTY     bool
	Environment     map[string]string
	Ctx             context.Context
}

type InitResult struct {
	Configuration PluginConfiguration `json:"configuration"`
	Path          string              `json:"path"`
	Diagnostics   []SetupDiagnostic   `json:"diagnostics"`
	Ready         bool                `json:"ready"`
}

var providerAliases = map[string]string{
	"cloudflare":      "cloudflare",
	"clef-cloudflare": "cloudflare",
	"local":           "local",
	"clef-local":      "local",
	"openai":          "openai",
	"openai-luna":     "openai",
	"decisions":       "openai",
	"offline":         "offline",
}

var permittedEnvironment = map[string]bool{
	"PERFDIGEST_CLOUDFLARE_ACCOUNT_ID": true,
	"PERFDIGEST_CLOUDFLARE_API_TOKEN":  true,
	"PERFDIGEST_DECISIONS_API_KEY":     true,
	"PERFDIGEST_CLEF_URL":              true,
}

func NormalizeSetupProvider(value string) (string, error) {
	if p, ok := providerAliases[value]; ok {
		return p, nil
	}
	return "", errors.New("Provider must be cloudflare, local, openai or offline.")
}

var localEndpointRe = regexp.MustCompile(`^http://127\.0\.0\.1:(\d{1,5})/v1/systemone$`)

func ValidateLocalEndpoint(value string) (string, error) {
	m := localEndpointRe.FindStringSubmatch(value)
	if m == nil {
		return "", errors.New("Local endpoint must be http://127.0.0.1:PORT/v1/systemone with no credentials, query or fragment.")
	}
	port, err := strconv.Atoi(m[1])
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("Local endpoint must be http://127.0.0.1:PORT/v1/systemone with no credentials, query or fragment.")
	}
	return value, nil
}

func workspaceDirectory(workspace string) (string, error) {
	real, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", errors.New("Workspace must be an existing directory.")
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		return "", errors.New("Workspace must be an existing directory.")
	}
	return real, nil
}

func repositoryDirectory(workspace string) (string, error) {
	for p := workspace; ; p = filepath.Dir(p) {
		_, err := os.Lstat(filepath.Join(p, ".git"))
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", errors.New("Cannot inspect workspace repository boundary.")
		}
		if p == filepath.Dir(p) {
			return workspace, nil
		}
	}
}

func canonicalReference(p string) (string, error) {
	real, err := filepath.EvalSymlinks(p)
	if err == nil {
		return real, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("Cannot access the external env-file path.")
	}
	parent := filepath.Dir(p)
	if parent == p {
		return "", errors.New("Cannot resolve the external env-file path.")
	}
	canonParent, err := canonicalReference(parent)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(parent, p)
	if err != nil {
		return "", errors.New("Cannot resolve the external env-file path.")
	}
	return filepath.Join(canonParent, rel), nil
}

func hasControlChar(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] <= 0x1f || s[i] == 0x7f {
			return true
		}
	}
	return false
}

func hasWhitespaceOrControl(s string) bool {
	for _, r := range s {
		if r <= 0x1f || r == 0x7f || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' {
			return true
		}
	}
	return false
}

func isWithin(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (!filepath.IsAbs(rel) && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func validateEnvReference(p string, workspace string) (string, error) {
	if !filepath.IsAbs(p) || hasControlChar(p) {
		return "", errors.New("Env file must be an absolute external file path, never a token or KEY=VALUE.")
	}
	repository, err := repositoryDirectory(workspace)
	if err != nil {
		return "", err
	}
	reference, err := canonicalReference(p)
	if err != nil {
		return "", err
	}
	if isWithin(workspace, reference) || isWithin(repository, reference) {
		return "", errors.New("Keep the env file outside the investigated workspace and repository.")
	}
	info, err := os.Lstat(p)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		return reference, nil
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("Env file must be a regular file, not a symbolic link.")
	}
	if info.Size() > 65536 {
		return "", errors.New("Env file exceeds the 64 KiB setup limit.")
	}
	if runtime.GOOS != "windows" {
		if info.Mode().Perm()&0o077 != 0 {
			return "", errors.New("Env file must be owned by the current user and private; set its permissions to 600.")
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			if int(st.Uid) != os.Getuid() {
				return "", errors.New("Env file must be owned by the current user and private; set its permissions to 600.")
			}
		}
	}
	return reference, nil
}

func validateConfigurationMap(raw map[string]any, workspace string) (PluginConfiguration, error) {
	if raw == nil {
		return PluginConfiguration{}, errors.New("Invalid PerfDigest configuration.")
	}
	allowed := map[string]bool{
		"version":       true,
		"provider":      true,
		"endpoint":      true,
		"envFile":       true,
		"decisionModel": true,
	}
	for k := range raw {
		if !allowed[k] {
			return PluginConfiguration{}, errors.New("Configuration may contain only version, provider, endpoint, envFile and decisionModel references.")
		}
	}
	vNum, ok := raw["version"].(float64)
	if !ok {
		if vInt, okInt := raw["version"].(int); okInt {
			vNum = float64(vInt)
			ok = true
		}
	}
	provRaw, okProv := raw["provider"].(string)
	if !ok || vNum != 1 || !okProv {
		return PluginConfiguration{}, errors.New("Invalid PerfDigest configuration version or provider.")
	}
	provider, err := NormalizeSetupProvider(provRaw)
	if err != nil {
		return PluginConfiguration{}, err
	}
	if epVal, exists := raw["endpoint"]; exists && epVal != nil {
		epStr, isStr := epVal.(string)
		if provider != "local" || !isStr {
			return PluginConfiguration{}, errors.New("Only the local provider accepts a configurable endpoint.")
		}
		_ = epStr
	}
	if efVal, exists := raw["envFile"]; exists && efVal != nil {
		if _, isStr := efVal.(string); !isStr {
			return PluginConfiguration{}, errors.New("Env file must be an absolute external file path.")
		}
	}
	if dmVal, exists := raw["decisionModel"]; exists && dmVal != nil {
		dmStr, isStr := dmVal.(string)
		if provider != "cloudflare" || !isStr || !IsCloudflareModelName(dmStr) {
			return PluginConfiguration{}, errors.New("Only the cloudflare provider accepts a decision model: clef-flash, clef, clef-omni.")
		}
	}
	cfg := PluginConfiguration{
		Version:  1,
		Provider: provider,
	}
	if provider == "local" {
		ep := DefaultLocalEndpoint
		if epStr, ok := raw["endpoint"].(string); ok && epStr != "" {
			ep = epStr
		}
		validatedEp, err := ValidateLocalEndpoint(ep)
		if err != nil {
			return PluginConfiguration{}, err
		}
		cfg.Endpoint = validatedEp
	}
	if efStr, ok := raw["envFile"].(string); ok && efStr != "" {
		validatedEf, err := validateEnvReference(efStr, workspace)
		if err != nil {
			return PluginConfiguration{}, err
		}
		cfg.EnvFile = validatedEf
	}
	if dmStr, ok := raw["decisionModel"].(string); ok && dmStr != "" {
		cfg.DecisionModel = dmStr
	}
	return cfg, nil
}

func checkConfigurationDirectory(workspace string) (string, error) {
	directory := filepath.Join(workspace, ".perfdigest")
	info, err := os.Lstat(directory)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return directory, nil
		}
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("The .perfdigest configuration directory must not be a symlink.")
	}
	return directory, nil
}

func LoadConfiguration(workspace string) (*PluginConfiguration, error) {
	if workspace == "" {
		var err error
		workspace, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	root, err := workspaceDirectory(workspace)
	if err != nil {
		return nil, err
	}
	directory, err := checkConfigurationDirectory(root)
	if err != nil {
		return nil, err
	}
	cfgPath := filepath.Join(directory, "config.json")
	info, err := os.Lstat(cfgPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16384 {
		return nil, errors.New("Configuration must be a regular file smaller than 16 KiB.")
	}
	source, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil, err
	}
	var raw any
	if err := json.Unmarshal(source, &raw); err != nil {
		return nil, errors.New("Configuration is not valid JSON.")
	}
	rawMap, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("Invalid PerfDigest configuration.")
	}
	cfg, err := validateConfigurationMap(rawMap, root)
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}

var envAssignmentRe = regexp.MustCompile(`^([A-Z][A-Z0-9_]*)=(.*)$`)

func parseDedicatedEnvironment(source string) (map[string]string, error) {
	values := make(map[string]string)
	lines := strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		m := envAssignmentRe.FindStringSubmatch(trimmed)
		if m == nil || !permittedEnvironment[m[1]] {
			return nil, fmt.Errorf("Env file line %d must assign a dedicated PerfDigest variable; general API keys and shell syntax are refused.", index+1)
		}
		key := m[1]
		if _, exists := values[key]; exists {
			return nil, fmt.Errorf("Env file has a duplicate assignment on line %d.", index+1)
		}
		val := strings.TrimSpace(m[2])
		if strings.HasPrefix(val, "\"") || strings.HasPrefix(val, "'") {
			if len(val) < 2 || val[len(val)-1] != val[0] {
				return nil, fmt.Errorf("Env file has an invalid quoted value on line %d.", index+1)
			}
			val = val[1 : len(val)-1]
		}
		if hasWhitespaceOrControl(val) {
			return nil, fmt.Errorf("Env file values must be single-line literals without whitespace (line %d).", index+1)
		}
		if key == "PERFDIGEST_CLEF_URL" && val != "" {
			if _, err := ValidateLocalEndpoint(val); err != nil {
				return nil, err
			}
		}
		values[key] = val
	}
	return values, nil
}

func configurationToMap(cfg PluginConfiguration) map[string]any {
	m := map[string]any{
		"version":  cfg.Version,
		"provider": cfg.Provider,
	}
	if cfg.Endpoint != "" {
		m["endpoint"] = cfg.Endpoint
	}
	if cfg.EnvFile != "" {
		m["envFile"] = cfg.EnvFile
	}
	if cfg.DecisionModel != "" {
		m["decisionModel"] = cfg.DecisionModel
	}
	return m
}

func ApplyConfigurationEnvironment(cfg PluginConfiguration, workspace string, environment map[string]string) error {
	if workspace == "" {
		var err error
		workspace, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	root, err := workspaceDirectory(workspace)
	if err != nil {
		return err
	}
	checked, err := validateConfigurationMap(configurationToMap(cfg), root)
	if err != nil {
		return err
	}
	values := make(map[string]string)
	if checked.EnvFile != "" {
		sourceBytes, err := os.ReadFile(checked.EnvFile)
		if err != nil {
			return errors.New("The configured external env file is missing or unreadable.")
		}
		values, err = parseDedicatedEnvironment(string(sourceBytes))
		if err != nil {
			return err
		}
	}
	if environment != nil {
		for k, v := range values {
			if _, exists := environment[k]; !exists {
				environment[k] = v
			}
		}
		if checked.Provider == "local" {
			environment["PERFDIGEST_CLEF_URL"] = checked.Endpoint
		}
	} else {
		for k, v := range values {
			if _, exists := os.LookupEnv(k); !exists {
				_ = os.Setenv(k, v)
			}
		}
		if checked.Provider == "local" {
			_ = os.Setenv("PERFDIGEST_CLEF_URL", checked.Endpoint)
		}
	}
	return nil
}

func saveConfiguration(cfg PluginConfiguration, workspace string) (string, error) {
	directory, err := checkConfigurationDirectory(workspace)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(directory, 0o700)
	}
	cfgPath := filepath.Join(directory, "config.json")
	if info, err := os.Lstat(cfgPath); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("Configuration must not be a symlink or special file.")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	tmpPath := filepath.Join(directory, fmt.Sprintf(".config-%s.tmp", hex.EncodeToString(rnd[:])))
	defer func() { _ = os.Remove(tmpPath) }()
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		_ = f.Close()
		return "", err
	}
	if _, err := f.Write(append(encoded, '\n')); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, cfgPath); err != nil {
		return "", err
	}
	return cfgPath, nil
}

const discoveryResponseLimit = 65536

func checkCloudflareConnection(ctx context.Context, account, token, model string) SetupDiagnostic {
	u, err := url.Parse(fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/models/search", account))
	if err != nil {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
		}
	}
	q := url.Values{}
	q.Set("search", model)
	q.Set("per_page", "1")
	q.Set("page", "1")
	u.RawQuery = q.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
		}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return errors.New("redirect not allowed")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := "Read-endpoint availability was not confirmed."
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			detail = "Check the account, token and Workers AI Read or Write permission."
		} else if resp.StatusCode == 429 {
			detail = "The read endpoint is rate-limited; this does not establish remaining inference quota."
		}
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: fmt.Sprintf("Cloudflare model-discovery read failed (HTTP %d). %s Inference and remaining quota were not checked.", resp.StatusCode, detail),
		}
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.Atoi(cl); err == nil && n > discoveryResponseLimit {
			return SetupDiagnostic{
				Check:   "endpoint",
				Status:  "error",
				Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
			}
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, discoveryResponseLimit+1))
	if err != nil || len(body) > discoveryResponseLimit || len(body) == 0 {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
		}
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery check failed: unreachable, redirected, cancelled, over the 5-second/64-KiB limit, or invalid response. Inference and remaining quota were not checked.",
		}
	}
	success, okS := parsed["success"].(bool)
	_, okR := parsed["result"].([]any)
	errsSlice, okE := parsed["errors"].([]any)
	if !okS || !success || !okR || !okE || len(errsSlice) != 0 {
		return SetupDiagnostic{
			Check:   "endpoint",
			Status:  "error",
			Message: "Cloudflare model-discovery read did not return a successful discovery response; readiness was not confirmed. Inference and remaining quota were not checked.",
		}
	}
	return SetupDiagnostic{
		Check:   "endpoint",
		Status:  "ok",
		Message: fmt.Sprintf("Cloudflare authenticated model-discovery read accepted (HTTP %d); model availability, inference and remaining quota were not checked.", resp.StatusCode),
	}
}

var cfHexAccountRe = regexp.MustCompile(`^(?i)[a-f0-9]{32}$`)

func diagnosticsFor(ctx context.Context, cfg PluginConfiguration, workspace string, environment map[string]string, checkConnection bool) []SetupDiagnostic {
	diagnostics := []SetupDiagnostic{
		{
			Check:   "configuration",
			Status:  "ok",
			Message: "Workspace configuration saved; it contains references only.",
		},
	}
	codexBin := "codex"
	if v, ok := environment["PERFDIGEST_CODEX_PATH"]; ok && v != "" {
		codexBin = v
	}
	type binCheck struct {
		name   string
		binary string
	}
	for _, bc := range []binCheck{{"uvx", "uvx"}, {"codex", codexBin}} {
		p, err := Executable(bc.binary, environment)
		okExec := false
		if err == nil {
			if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
				okExec = true
			}
		}
		if okExec {
			msg := "Codex executable found; existing login was not checked."
			if bc.name == "uvx" {
				msg = "uvx executable found; Python MCP installation was not started."
			}
			diagnostics = append(diagnostics, SetupDiagnostic{Check: bc.name, Status: "ok", Message: msg})
		} else {
			status := "warning"
			msg := "Codex is missing or not executable; install/login before using --agent codex."
			if bc.name == "uvx" {
				status = "error"
				msg = "uvx is missing or not executable; install uv before collecting evidence."
			}
			diagnostics = append(diagnostics, SetupDiagnostic{Check: bc.name, Status: status, Message: msg})
		}
	}
	effective := make(map[string]string, len(environment))
	for k, v := range environment {
		effective[k] = v
	}
	environmentReady := true
	if err := ApplyConfigurationEnvironment(cfg, workspace, effective); err == nil {
		status := "skipped"
		msg := "No external env file configured; dedicated variables are read from the runner environment."
		if cfg.EnvFile != "" {
			status = "ok"
			msg = "Private external env file read; values are not displayed or saved in configuration."
		}
		diagnostics = append(diagnostics, SetupDiagnostic{Check: "env_file", Status: status, Message: msg})
	} else {
		environmentReady = false
		diagnostics = append(diagnostics, SetupDiagnostic{
			Check:   "env_file",
			Status:  "error",
			Message: "External env file is missing, unreadable or invalid; no values were applied.",
		})
	}

	switch cfg.Provider {
	case "cloudflare":
		account := strings.TrimSpace(effective["PERFDIGEST_CLOUDFLARE_ACCOUNT_ID"])
		token := strings.TrimSpace(effective["PERFDIGEST_CLOUDFLARE_API_TOKEN"])
		credentialsReady := account != "" && cfHexAccountRe.MatchString(account) && token != "" && !strings.ContainsAny(token, "\r\n")
		if credentialsReady {
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "credentials",
				Status:  "ok",
				Message: "Cloudflare account ID and token present; presence alone does not verify access or quota.",
			})
		} else {
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "credentials",
				Status:  "error",
				Message: "Set PERFDIGEST_CLOUDFLARE_ACCOUNT_ID (32 hex characters) and PERFDIGEST_CLOUDFLARE_API_TOKEN in the private runner environment.",
			})
		}
		if checkConnection && environmentReady && credentialsReady {
			dm := cfg.DecisionModel
			if dm == "" {
				dm = "clef-flash"
			}
			diagnostics = append(diagnostics, checkCloudflareConnection(ctx, account, token, dm))
		} else {
			msg := "Hosted endpoint was not contacted; use init --check-connection for one read-only Cloudflare check. Inference and remaining quota remain unverified."
			if checkConnection {
				msg = "Cloudflare was not contacted because its credentials or external env file are missing or invalid."
			}
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "endpoint",
				Status:  "skipped",
				Message: msg,
			})
		}
	case "openai":
		present := strings.TrimSpace(effective["PERFDIGEST_DECISIONS_API_KEY"]) != ""
		if present {
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "credentials",
				Status:  "ok",
				Message: "Dedicated Decisions key present; authentication, model access and budget remain unverified.",
			})
		} else {
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "credentials",
				Status:  "error",
				Message: "Set PERFDIGEST_DECISIONS_API_KEY in the private runner environment; OPENAI_API_KEY is not used.",
			})
		}
		diagnostics = append(diagnostics, SetupDiagnostic{
			Check:   "endpoint",
			Status:  "skipped",
			Message: "OpenAI was not contacted; --check-connection supports Cloudflare only. Authentication, inference and remaining quota remain unverified.",
		})
	default:
		diagnostics = append(diagnostics, SetupDiagnostic{
			Check:   "credentials",
			Status:  "skipped",
			Message: "This provider does not require hosted API credentials.",
		})
		if cfg.Provider == "local" {
			u, err := url.Parse(cfg.Endpoint)
			if err == nil {
				u.Path = "/health"
				u.RawQuery = ""
				reqCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
				req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
				client := &http.Client{
					CheckRedirect: func(req *http.Request, via []*http.Request) error {
						return errors.New("redirect not allowed")
					},
				}
				if reqErr == nil {
					if resp, doErr := client.Do(req); doErr == nil {
						_ = resp.Body.Close()
						cancel()
						if resp.StatusCode >= 200 && resp.StatusCode < 300 {
							diagnostics = append(diagnostics, SetupDiagnostic{
								Check:   "endpoint",
								Status:  "ok",
								Message: fmt.Sprintf("Local /health returned HTTP %d; inference and model identity remain unverified.", resp.StatusCode),
							})
						} else {
							diagnostics = append(diagnostics, SetupDiagnostic{
								Check:   "endpoint",
								Status:  "error",
								Message: fmt.Sprintf("Local server returned HTTP %d for /health; readiness was not confirmed.", resp.StatusCode),
							})
						}
						return diagnostics
					}
				}
				cancel()
			}
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "endpoint",
				Status:  "error",
				Message: "Local /health was unreachable, redirected or timed out; start llama.cpp at the configured address.",
			})
		} else {
			diagnostics = append(diagnostics, SetupDiagnostic{
				Check:   "endpoint",
				Status:  "skipped",
				Message: "Offline selected explicitly; no endpoint or model is contacted.",
			})
		}
	}
	return diagnostics
}

func isFileTTY(f *os.File) bool {
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

func currentEnvMap() map[string]string {
	m := make(map[string]string)
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx > 0 {
			m[entry[:idx]] = entry[idx+1:]
		}
	}
	return m
}

func InitConfiguration(options InitOptions) (InitResult, error) {
	ctx := options.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	input := options.Input
	inputIsTTY := options.InputIsTTY
	if input == nil {
		input = os.Stdin
		inputIsTTY = isFileTTY(os.Stdin)
	}
	output := options.Output
	outputIsTTY := options.OutputIsTTY
	if output == nil {
		output = os.Stderr
		outputIsTTY = isFileTTY(os.Stderr)
	}
	if options.Yes && options.Provider == nil {
		return InitResult{}, errors.New("Noninteractive init requires --provider cloudflare|local|openai|offline together with --yes.")
	}
	if !options.Yes && (!inputIsTTY || !outputIsTTY) {
		return InitResult{}, errors.New("Interactive init requires a terminal. For automation specify --provider cloudflare|local|openai|offline and --yes.")
	}
	ws := options.Workspace
	if ws == "" {
		var err error
		ws, err = os.Getwd()
		if err != nil {
			return InitResult{}, err
		}
	}
	workspace, err := workspaceDirectory(ws)
	if err != nil {
		return InitResult{}, err
	}
	previous, err := LoadConfiguration(workspace)
	if err != nil {
		return InitResult{}, err
	}
	environment := options.Environment
	if environment == nil {
		environment = currentEnvMap()
	}

	var reader *bufio.Reader
	if !options.Yes {
		reader = bufio.NewReader(input)
	}
	ask := func(prompt string) (string, error) {
		if reader == nil {
			return "", errors.New("Setup cancelled before saving configuration.")
		}
		_, _ = io.WriteString(output, prompt)
		type readRes struct {
			line string
			err  error
		}
		ch := make(chan readRes, 1)
		go func() {
			line, err := reader.ReadString('\n')
			ch <- readRes{line: line, err: err}
		}()
		select {
		case <-ctx.Done():
			return "", errors.New("Setup cancelled before saving configuration.")
		case res := <-ch:
			if res.err != nil && res.line == "" {
				return "", errors.New("Setup cancelled before saving configuration.")
			}
			return strings.TrimRight(res.line, "\r\n"), nil
		}
	}

	_, _ = io.WriteString(output, "PerfDigest provider setup — no model calls\n")
	var provider string
	if options.Provider != nil {
		p, err := NormalizeSetupProvider(*options.Provider)
		if err != nil {
			return InitResult{}, err
		}
		provider = p
	}
	if provider == "" {
		_, _ = io.WriteString(output, "  1. Cloudflare (recommended demo)\n  2. Local llama.cpp\n  3. OpenAI Decisions\n  4. Offline (deterministic, no model)\n")
		preferred := "cloudflare"
		if previous != nil && previous.Provider != "" {
			preferred = previous.Provider
		}
		for provider == "" {
			ans, err := ask(fmt.Sprintf("Provider [%s]: ", preferred))
			if err != nil {
				return InitResult{}, err
			}
			choice := strings.TrimSpace(ans)
			if choice == "" {
				choice = preferred
			}
			if idx, err := strconv.Atoi(choice); err == nil && idx >= 1 && idx <= len(setupProviders) {
				choice = setupProviders[idx-1]
			}
			if p, err := NormalizeSetupProvider(choice); err == nil {
				provider = p
			} else {
				_, _ = io.WriteString(output, "Choose 1–4 or cloudflare, local, openai, offline.\n")
			}
		}
	}

	var envFile string
	if options.EnvFile != nil {
		envFile = strings.TrimSpace(*options.EnvFile)
	} else if previous != nil && previous.Provider == provider {
		envFile = previous.EnvFile
	}
	if reader != nil && options.EnvFile == nil && (provider == "cloudflare" || provider == "openai") {
		prompt := "Private external env-file absolute path [Enter uses current environment]: "
		if envFile != "" {
			prompt = "External env-file absolute path [Enter keeps configured path; - uses current environment]: "
		}
		ans, err := ask(prompt)
		if err != nil {
			return InitResult{}, err
		}
		trimmed := strings.TrimSpace(ans)
		if trimmed == "-" {
			envFile = ""
		} else if trimmed != "" {
			envFile = trimmed
		}
	}

	var endpoint *string
	if options.Endpoint != nil {
		ep := *options.Endpoint
		endpoint = &ep
	} else if provider == "local" {
		ep := ""
		if previous != nil && previous.Provider == "local" {
			ep = previous.Endpoint
		}
		if ep == "" {
			if envEp, ok := environment["PERFDIGEST_CLEF_URL"]; ok && envEp != "" {
				ep = envEp
			} else {
				ep = DefaultLocalEndpoint
			}
		}
		if _, err := ValidateLocalEndpoint(ep); err != nil {
			return InitResult{}, err
		}
		if reader != nil {
			ans, err := ask(fmt.Sprintf("Local endpoint [%s]: ", ep))
			if err != nil {
				return InitResult{}, err
			}
			if trimmed := strings.TrimSpace(ans); trimmed != "" {
				ep = trimmed
			}
		}
		endpoint = &ep
	}

	var decisionModel *string
	if options.DecisionModel != nil {
		dm := *options.DecisionModel
		decisionModel = &dm
	} else if previous != nil && previous.Provider == provider && previous.DecisionModel != "" {
		dm := previous.DecisionModel
		decisionModel = &dm
	}

	rawCfg := map[string]any{
		"version":  1,
		"provider": provider,
	}
	if endpoint != nil {
		rawCfg["endpoint"] = *endpoint
	}
	if envFile != "" {
		rawCfg["envFile"] = envFile
	}
	if decisionModel != nil {
		rawCfg["decisionModel"] = *decisionModel
	}
	cfg, err := validateConfigurationMap(rawCfg, workspace)
	if err != nil {
		return InitResult{}, err
	}

	if reader != nil {
		_, _ = io.WriteString(output, fmt.Sprintf("Selected provider: %s\n", provider))
		verb := "Save"
		if previous != nil {
			verb = "Replace"
		}
		ans, err := ask(fmt.Sprintf("%s workspace configuration? [Y/n]: ", verb))
		if err != nil {
			return InitResult{}, err
		}
		trimmed := strings.ToLower(strings.TrimSpace(ans))
		if trimmed != "" && trimmed != "y" && trimmed != "yes" {
			return InitResult{}, errors.New("Setup cancelled before saving configuration.")
		}
	}
	if err := ctx.Err(); err != nil {
		return InitResult{}, err
	}
	savedPath, err := saveConfiguration(cfg, workspace)
	if err != nil {
		return InitResult{}, err
	}
	_, _ = io.WriteString(output, fmt.Sprintf("Active provider: %s\n", provider))
	if cfg.Endpoint != "" {
		_, _ = io.WriteString(output, fmt.Sprintf("Local endpoint: %s\n", cfg.Endpoint))
	}
	if cfg.Provider == "cloudflare" {
		dm := cfg.DecisionModel
		if dm == "" {
			dm = "clef-flash"
		}
		_, _ = io.WriteString(output, fmt.Sprintf("Cloudflare decision model: %s\n", dm))
	}
	diagnostics := diagnosticsFor(ctx, cfg, workspace, environment, options.CheckConnection)
	ready := true
	for _, d := range diagnostics {
		_, _ = io.WriteString(output, fmt.Sprintf("[%s] %s\n", d.Status, d.Message))
		if d.Status == "error" {
			ready = false
		}
	}
	statusTail := "Prerequisite checks passed."
	if !ready {
		statusTail = "Some prerequisites need attention."
	}
	_, _ = io.WriteString(output, fmt.Sprintf("Configuration saved to .perfdigest/config.json. %s\n", statusTail))
	return InitResult{
		Configuration: cfg,
		Path:          savedPath,
		Diagnostics:   diagnostics,
		Ready:         ready,
	}, nil
}
