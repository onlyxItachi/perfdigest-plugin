package perfdigest

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const MaxReportBytes = 20 * 1024 * 1024
const StreamHashChunkBytes = 64 * 1024

type ReportFileInfo struct {
	Path       string `json:"path"`
	Sha256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	ModifiedAt string `json:"modifiedAt"`
}

func randomHex(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256StreamingFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	h := sha256.New()
	buf := make([]byte, StreamHashChunkBytes)
	var total int64
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > MaxReportBytes {
				return "", 0, fmt.Errorf("MVP reports must be regular files no larger than 20 MiB")
			}
			_, _ = h.Write(buf[:n])
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", 0, rerr
		}
	}
	if total <= 0 {
		return "", 0, fmt.Errorf("MVP reports must be regular files no larger than 20 MiB")
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}

// ReportFile resolves a report artifact path within workspace, enforces containment,
// rejects symlinks and non-regular or out-of-bounds files, and computes streaming 64 KB SHA-256.
func ReportFile(workspace, relPath, knownWorkspaceRealpath string) (ReportFileInfo, error) {
	root := knownWorkspaceRealpath
	if root == "" {
		var err error
		root, err = filepath.EvalSymlinks(workspace)
		if err != nil {
			return ReportFileInfo{}, err
		}
	}
	var candidate string
	if filepath.IsAbs(relPath) {
		candidate = filepath.Clean(relPath)
	} else {
		candidate = filepath.Join(root, relPath)
	}

	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return ReportFileInfo{}, err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ReportFileInfo{}, fmt.Errorf("Report path must stay inside the workspace (including symlinks)")
	}

	linfo, err := os.Lstat(candidate)
	if err != nil {
		return ReportFileInfo{}, err
	}
	if linfo.Mode()&os.ModeSymlink != 0 || !linfo.Mode().IsRegular() {
		return ReportFileInfo{}, fmt.Errorf("MVP reports must be regular files no larger than 20 MiB")
	}

	meta, err := os.Stat(resolved)
	if err != nil {
		return ReportFileInfo{}, err
	}
	if !meta.Mode().IsRegular() || meta.Size() <= 0 || meta.Size() > MaxReportBytes {
		return ReportFileInfo{}, fmt.Errorf("MVP reports must be regular files no larger than 20 MiB")
	}

	sum, nbytes, err := sha256StreamingFile(resolved)
	if err != nil {
		return ReportFileInfo{}, err
	}

	return ReportFileInfo{
		Path:       resolved,
		Sha256:     sum,
		Bytes:      nbytes,
		ModifiedAt: meta.ModTime().UTC().Round(time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

// WritePrivateFile atomically writes content to path with 0600 permissions.
func WritePrivateFile(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".tmp-%s", randomHex(8)))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(content)
	cerr := f.Close()
	if werr != nil {
		_ = os.Remove(tmp)
		return werr
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return cerr
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// WriteJSON marshals data with 2-space indentation, redacts secrets, and writes atomically with 0600 permissions.
func WriteJSON(path string, data any) error {
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	redacted := Redact(string(raw)) + "\n"
	return WritePrivateFile(path, []byte(redacted))
}

// AssertSafeDirectoryChain creates or validates each directory segment under root with 0700 permissions,
// rejecting symlinks, non-directories, and invalid path segments.
func AssertSafeDirectoryChain(root string, segments ...string) (string, error) {
	current, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, `/\`) || strings.ContainsRune(seg, 0) {
			return "", fmt.Errorf("Invalid directory segment: %s", seg)
		}
		current = filepath.Join(current, seg)
		if info, lerr := os.Lstat(current); lerr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return "", fmt.Errorf("Refusing non-directory or symlink path inside .perfdigest: %s", seg)
			}
		} else if os.IsNotExist(lerr) {
			if mkerr := os.Mkdir(current, 0o700); mkerr != nil && !os.IsExist(mkerr) {
				return "", mkerr
			}
		} else {
			return "", lerr
		}
		_ = os.Chmod(current, 0o700)
	}
	return current, nil
}

// CreateExclusiveDirectory validates/creates parentSegments safely and atomically creates leaf
// with 0700 permissions, failing with os.ErrExist if leaf already exists.
func CreateExclusiveDirectory(root string, leaf string, parentSegments ...string) (string, error) {
	if leaf == "" || leaf == "." || leaf == ".." || strings.ContainsAny(leaf, `/\`) || strings.ContainsRune(leaf, 0) {
		return "", fmt.Errorf("Invalid directory segment: %s", leaf)
	}
	parent, err := AssertSafeDirectoryChain(root, parentSegments...)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, leaf)
	if err := os.Mkdir(target, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(target, 0o700)
	return target, nil
}

// AssertContainedRegularFile verifies candidatePath is a regular non-symlink file inside workspaceRoot.
func AssertContainedRegularFile(workspaceRoot, candidatePath string) (string, error) {
	root, err := filepath.EvalSymlinks(workspaceRoot)
	if err != nil {
		return "", err
	}
	abs := candidatePath
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, abs)
	}
	abs = filepath.Clean(abs)
	linfo, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if linfo.Mode()&os.ModeSymlink != 0 || !linfo.Mode().IsRegular() {
		return "", fmt.Errorf("Artifact path must be a regular non-symlink file")
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("Artifact path must stay inside the workspace")
	}
	return resolved, nil
}

// EnsureRunDirectory validates and creates a pre-allocated direct child of .perfdigest/runs inside workspace.
func EnsureRunDirectory(workspace, runDirectory string) (string, error) {
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", err
	}
	runsRoot, err := AssertSafeDirectoryChain(root, ".perfdigest", "runs")
	if err != nil {
		return "", err
	}
	candidate := runDirectory
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(root, candidate)
	}
	candidate = filepath.Clean(candidate)
	rel, err := filepath.Rel(runsRoot, candidate)
	if err != nil || rel == "" || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) || strings.ContainsAny(rel, `/\`) {
		return "", fmt.Errorf("runDirectory must be a direct child of .perfdigest/runs inside the workspace")
	}
	return AssertSafeDirectoryChain(root, ".perfdigest", "runs", rel)
}

// NewRunDirectory creates .perfdigest/runs/<ISO-timestamp>-<uuid8> with 0700 permissions,
// rejecting symlinked .perfdigest directories.
func NewRunDirectory(workspace string) (string, error) {
	ts := strings.ReplaceAll(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), ":", "-")
	return AssertSafeDirectoryChain(workspace, ".perfdigest", "runs", fmt.Sprintf("%s-%s", ts, randomHex(4)))
}
