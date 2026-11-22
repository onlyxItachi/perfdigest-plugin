//go:build windows

package perfdigest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func configureProcessGroup(cmd *exec.Cmd) {
}

func configureDetachedProcess(cmd *exec.Cmd) {
}

type windowsCimProcess struct {
	CreationDate string `json:"CreationDate"`
	CommandLine  string `json:"CommandLine"`
}

func parseWindowsCimJSON(raw string) (exists bool, startID string, command string, ok bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false, "", "", true
	}
	var proc windowsCimProcess
	if err := json.Unmarshal([]byte(trimmed), &proc); err != nil {
		return false, "", "", false
	}
	if strings.TrimSpace(proc.CreationDate) == "" || strings.TrimSpace(proc.CommandLine) == "" {
		return true, "", "", false
	}
	return true, strings.TrimSpace(proc.CreationDate), proc.CommandLine, true
}

func queryWindowsProcess(pid int) (exists bool, startID string, command string, ok bool) {
	if pid <= 0 {
		return false, "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	psCmd := fmt.Sprintf(
		"$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%d'; if ($null -ne $p) { $p | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress }",
		pid,
	)
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	out, err := cmd.Output()
	if err != nil {
		return false, "", "", false
	}
	return parseWindowsCimJSON(string(out))
}

func readProcessStartID(pid int) string {
	exists, startID, _, ok := queryWindowsProcess(pid)
	if !ok || !exists {
		return ""
	}
	return startID
}

func checkWorkerProcessStatus(pid int, expectedStartID, expectedMarker string) (alive bool, owned bool) {
	if pid <= 0 {
		return false, false
	}
	exists, startID, command, ok := queryWindowsProcess(pid)
	if !ok {
		// Fail closed: cannot verify ownership on Windows, never signal/taskkill an unverified PID.
		return true, false
	}
	if !exists {
		return false, false
	}
	if expectedStartID == "" || expectedMarker == "" {
		return true, false
	}
	if startID != expectedStartID || !strings.Contains(command, expectedMarker) {
		return true, false
	}
	return true, true
}

func signalProcessGroupByPID(pid int, force bool) bool {
	if pid <= 0 {
		return false
	}
	pidStr := strconv.Itoa(pid)
	if !force {
		return exec.Command("taskkill", "/T", "/PID", pidStr).Run() == nil
	}
	return exec.Command("taskkill", "/F", "/T", "/PID", pidStr).Run() == nil
}

func terminateProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pidStr := strconv.Itoa(cmd.Process.Pid)
	if !force {
		if err := exec.Command("taskkill", "/T", "/PID", pidStr).Run(); err != nil {
			_ = cmd.Process.Kill()
		}
		return
	}
	_ = exec.Command("taskkill", "/F", "/T", "/PID", pidStr).Run()
	_ = cmd.Process.Kill()
}

func waitStatusSignalName(exitErr *exec.ExitError) *string {
	return nil
}

func verifyFileOwnerMatch(info os.FileInfo) error {
	return nil
}
