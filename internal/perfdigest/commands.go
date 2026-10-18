package perfdigest

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const MaxCommandOutputBytes = 16_000

type boundedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rem := b.max - b.buf.Len()
	if rem > 0 {
		if len(p) <= rem {
			b.buf.Write(p)
		} else {
			b.buf.Write(p[:rem])
		}
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
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
		return fmt.Sprintf("SIG(%d)", int(sig))
	}
}

// RunCommand executes a CommandSpec without a shell, using ChildEnvironment(), bounded timeout,
// SIGTERM -> SIGKILL escalation, and 16,000-byte output cap.
func RunCommand(ctx context.Context, spec CommandSpec, cwd string) (CommandReceipt, error) {
	if ctx != nil && ctx.Err() != nil {
		return CommandReceipt{}, ctx.Err()
	}
	timeoutMs := spec.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 30_000
	}
	if timeoutMs < 100 || timeoutMs > 120_000 {
		return CommandReceipt{}, fmt.Errorf("command timeoutMs must be between 100 and 120000")
	}

	args := spec.Args
	if args == nil {
		args = []string{}
	}
	startedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	start := time.Now()
	receipt := CommandReceipt{
		Command:   spec.Command,
		Args:      args,
		StartedAt: startedAt,
		ElapsedMs: 0,
		ExitCode:  nil,
		Signal:    nil,
		TimedOut:  false,
		Aborted:   false,
		Stdout:    "",
		Stderr:    "",
	}

	cmd := exec.Command(spec.Command, args...)
	cmd.Dir = cwd
	cmd.Env = ChildEnvSlice(nil)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdoutBuf := &boundedBuffer{max: MaxCommandOutputBytes}
	stderrBuf := &boundedBuffer{max: MaxCommandOutputBytes}
	cmd.Stdout = stdoutBuf
	cmd.Stderr = stderrBuf

	if err := cmd.Start(); err != nil {
		return CommandReceipt{}, fmt.Errorf("%s", Redact(err.Error()))
	}

	var mu sync.Mutex
	stopped := false
	var killTimer *time.Timer
	stopProcess := func() {
		mu.Lock()
		defer mu.Unlock()
		if stopped || cmd.Process == nil {
			return
		}
		stopped = true
		pid := cmd.Process.Pid
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		killTimer = time.AfterFunc(500*time.Millisecond, func() {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		})
	}

	doneCh := make(chan error, 1)
	go func() {
		doneCh <- cmd.Wait()
	}()

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()

	var ctxDone <-chan struct{}
	if ctx != nil {
		ctxDone = ctx.Done()
	}

	var waitErr error
	select {
	case waitErr = <-doneCh:
	case <-timer.C:
		mu.Lock()
		receipt.TimedOut = true
		mu.Unlock()
		stopProcess()
		waitErr = <-doneCh
	case <-ctxDone:
		mu.Lock()
		receipt.Aborted = true
		mu.Unlock()
		stopProcess()
		waitErr = <-doneCh
	}

	mu.Lock()
	if killTimer != nil {
		killTimer.Stop()
	}
	mu.Unlock()

	elapsedMs := float64(time.Since(start).Microseconds()) / 1000.0
	receipt.ElapsedMs = math.Round(elapsedMs*100) / 100
	receipt.Stdout = Redact(stdoutBuf.String())
	receipt.Stderr = Redact(stderrBuf.String())

	if waitErr == nil {
		zero := 0
		receipt.ExitCode = &zero
	} else if exitErr, ok := waitErr.(*exec.ExitError); ok {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			s := signalName(status.Signal())
			receipt.Signal = &s
			receipt.ExitCode = nil
		} else {
			code := exitErr.ExitCode()
			receipt.ExitCode = &code
		}
	} else {
		return CommandReceipt{}, fmt.Errorf("%s", Redact(waitErr.Error()))
	}

	return receipt, nil
}

// CommandPassed returns true only if the command exited with code 0 without timeout, abort, or signal.
func CommandPassed(receipt CommandReceipt) bool {
	return receipt.ExitCode != nil && *receipt.ExitCode == 0 && !receipt.TimedOut && !receipt.Aborted && receipt.Signal == nil
}
