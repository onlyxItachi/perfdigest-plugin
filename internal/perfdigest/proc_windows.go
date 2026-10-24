//go:build windows

package perfdigest

import (
	"os"
	"os/exec"
	"strconv"
)

func configureProcessGroup(cmd *exec.Cmd) {
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
