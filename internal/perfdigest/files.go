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
		ModifiedAt: meta.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"),
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

// NewRunDirectory creates .perfdigest/runs/<ISO-timestamp>-<uuid8> with 0700 permissions,
// rejecting symlinked .perfdigest directories.
func NewRunDirectory(workspace string) (string, error) {
	pdDir := filepath.Join(workspace, ".perfdigest")
	if info, err := os.Lstat(pdDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", fmt.Errorf("The .perfdigest configuration directory must not be a symlink.")
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	runsDir := filepath.Join(pdDir, "runs")
	if info, err := os.Lstat(runsDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", fmt.Errorf("The .perfdigest/runs directory must not be a symlink.")
		}
	}
	ts := strings.ReplaceAll(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), ":", "-")
	dir := filepath.Join(runsDir, fmt.Sprintf("%s-%s", ts, randomHex(4)))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(pdDir, 0o700)
	_ = os.Chmod(runsDir, 0o700)
	_ = os.Chmod(dir, 0o700)
	return dir, nil
}
