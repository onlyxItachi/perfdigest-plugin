//go:build !windows

package perfdigest

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func configureProcessGroup(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func configureDetachedProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func parseLinuxProcStat(pid int) (state string, startID string, ok bool) {
	if runtime.GOOS != "linux" || pid <= 0 {
		return "", "", false
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", "", false
	}
	s := string(raw)
	closeIdx := strings.LastIndexByte(s, ')')
	if closeIdx == -1 || closeIdx+2 >= len(s) {
		return "", "", false
	}
	fields := strings.Fields(s[closeIdx+2:])
	if len(fields) < 20 {
		return "", "", false
	}
	return fields[0], fields[19], true
}

// parsePsProcessLine parses `LC_ALL=C ps -o stat=,lstart=,command= -p <pid>` output.
// Expected format: "<STAT> <Day> <Mon> <DD> <HH:MM:SS> <YYYY> <COMMAND...>"
func parsePsProcessLine(raw string) (state string, startID string, command string, ok bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", "", false
	}
	// Take first non-empty line in case of trailing lines.
	if nl := strings.IndexByte(trimmed, '\n'); nl >= 0 {
		trimmed = strings.TrimSpace(trimmed[:nl])
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 7 {
		return "", "", "", false
	}
	state = fields[0]
	startID = strings.Join(fields[1:6], " ")
	command = strings.Join(fields[6:], " ")
	return state, startID, command, true
}

func queryPsProcess(pid int) (state string, startID string, command string, ok bool) {
	if pid <= 0 {
		return "", "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-o", "stat=,lstart=,command=", "-p", strconv.Itoa(pid))
	env := ChildEnvSlice(nil)
	env = append(env, "LC_ALL=C")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		return "", "", "", false
	}
	return parsePsProcessLine(string(out))
}

func isBSDOrDarwinOS(goos string) bool {
	switch goos {
	case "darwin", "freebsd", "openbsd", "netbsd", "dragonfly":
		return true
	default:
		return false
	}
}

func readProcessStartID(pid int) string {
	if runtime.GOOS == "linux" {
		_, startID, ok := parseLinuxProcStat(pid)
		if !ok {
			return ""
		}
		return startID
	}
	if isBSDOrDarwinOS(runtime.GOOS) {
		_, startID, _, ok := queryPsProcess(pid)
		if !ok {
			return ""
		}
		return startID
	}
	return ""
}

func readLinuxProcCmdline(pid int) (string, bool) {
	if runtime.GOOS != "linux" || pid <= 0 {
		return "", false
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil || len(raw) == 0 {
		return "", false
	}
	return string(bytes.ReplaceAll(raw, []byte{0}, []byte{' '})), true
}

type processInspectFuncs struct {
	killZero   func(pid int) error
	linuxStat  func(pid int) (state string, startID string, ok bool)
	linuxCmd   func(pid int) (cmdline string, ok bool)
	psQuery    func(pid int) (state string, startID string, command string, ok bool)
	winQuery   func(pid int) (exists bool, startID string, command string, ok bool)
}

func evaluateWorkerProcessStatus(goos string, pid int, expectedStartID, expectedMarker string, funcs processInspectFuncs) (alive bool, owned bool) {
	if pid <= 0 {
		return false, false
	}
	if goos == "windows" {
		if funcs.winQuery == nil {
			// Fail closed when Windows process ownership inspection is unavailable.
			return true, false
		}
		exists, startID, command, ok := funcs.winQuery(pid)
		if !ok {
			// Query failed -> fail closed (never signal an unverified PID).
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

	if funcs.killZero != nil {
		err := funcs.killZero(pid)
		if err != nil {
			if errors.Is(err, syscall.EPERM) {
				return true, false
			}
			return false, false
		}
	}

	if goos == "linux" {
		if funcs.linuxStat == nil || funcs.linuxCmd == nil {
			return true, false
		}
		state, startID, ok := funcs.linuxStat(pid)
		if !ok {
			return false, false
		}
		if state == "Z" || state == "X" {
			return false, true
		}
		if expectedStartID == "" || expectedMarker == "" || startID != expectedStartID {
			return true, false
		}
		cmdline, hasCmd := funcs.linuxCmd(pid)
		if !hasCmd || !strings.Contains(cmdline, expectedMarker) {
			return true, false
		}
		return true, true
	}

	if isBSDOrDarwinOS(goos) {
		if funcs.psQuery == nil {
			return true, false
		}
		state, startID, command, ok := funcs.psQuery(pid)
		if !ok {
			// Re-check whether the process exited between kill(0) and ps.
			if funcs.killZero != nil && errors.Is(funcs.killZero(pid), syscall.ESRCH) {
				return false, false
			}
			return true, false
		}
		if strings.HasPrefix(state, "Z") || strings.HasPrefix(state, "X") {
			return false, true
		}
		if expectedStartID == "" || expectedMarker == "" || startID != expectedStartID {
			return true, false
		}
		if !strings.Contains(command, expectedMarker) {
			return true, false
		}
		return true, true
	}

	// Unknown OS: fail closed — never report ownership as verified.
	return true, false
}

func checkWorkerProcessStatus(pid int, expectedStartID, expectedMarker string) (alive bool, owned bool) {
	return evaluateWorkerProcessStatus(runtime.GOOS, pid, expectedStartID, expectedMarker, processInspectFuncs{
		killZero:  func(p int) error { return syscall.Kill(p, 0) },
		linuxStat: parseLinuxProcStat,
		linuxCmd:  readLinuxProcCmdline,
		psQuery:   queryPsProcess,
	})
}

func signalProcessGroupByPID(pid int, force bool) bool {
	if pid <= 0 {
		return false
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-pid, sig); err == nil {
		return true
	}
	return syscall.Kill(pid, sig) == nil
}

func terminateProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-pid, sig); err != nil {
		if force {
			_ = cmd.Process.Kill()
		} else {
			_ = cmd.Process.Signal(sig)
		}
	}
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGABRT:
		return "SIGABRT"
	default:
		return sig.String()
	}
}

func waitStatusSignalName(exitErr *exec.ExitError) *string {
	if exitErr == nil {
		return nil
	}
	if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		s := signalName(ws.Signal())
		return &s
	}
	return nil
}

func verifyFileOwnerMatch(info os.FileInfo) error {
	if info == nil {
		return nil
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return fmt.Errorf("Configuration file owner does not match current user")
	}
	return nil
}
