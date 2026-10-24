package perfdigest

import (
	"os"
	"path/filepath"
)

func locateDemoScript(workspace string) (string, error) {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		if realExe, err := filepath.EvalSymlinks(exe); err == nil {
			exe = realExe
		}
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(filepath.Dir(exeDir), "examples", "cpu-workload.mjs"),
			filepath.Join(exeDir, "..", "perfdigest-plugin", "examples", "cpu-workload.mjs"),
		)
	}
	candidates = append(candidates,
		filepath.Join(workspace, "examples", "cpu-workload.mjs"),
		filepath.Join(workspace, "node_modules", "perfdigest-plugin", "examples", "cpu-workload.mjs"),
	)
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return filepath.Join(workspace, "examples", "cpu-workload.mjs"), nil
}

func DemoManifest(workspace string, usePerf bool) (Manifest, error) {
	dataDirectory, err := NewRunDirectory(workspace)
	if err != nil {
		return Manifest{}, err
	}
	tracePath, err := filepath.Rel(workspace, filepath.Join(dataDirectory, "cpu.chrome-trace.json"))
	if err != nil {
		return Manifest{}, err
	}
	statPath, err := filepath.Rel(workspace, filepath.Join(dataDirectory, "cpu.perf-stat.json"))
	if err != nil {
		return Manifest{}, err
	}
	nodePath, err := Executable("node", nil)
	if err != nil {
		return Manifest{}, err
	}
	script, err := locateDemoScript(workspace)
	if err != nil {
		return Manifest{}, err
	}
	args := []string{script, tracePath}
	var capture CommandSpec
	if usePerf {
		perfPath, err := Executable("perf", nil)
		if err != nil {
			return Manifest{}, err
		}
		capture = CommandSpec{
			Command:   perfPath,
			Args:      append([]string{"stat", "-j", "-e", "task-clock,cycles,instructions", "-o", statPath, "--", nodePath}, args...),
			TimeoutMs: 30000,
		}
	} else {
		capture = CommandSpec{
			Command:   nodePath,
			Args:      args,
			TimeoutMs: 30000,
		}
	}
	reports := []ReportSpec{
		{
			ID:          "traversal-timing",
			Path:        tracePath,
			Format:      "chrome-trace",
			Description: "Genuine local CPU elapsed spans for row-major and column-major traversal, with checksums.",
		},
	}
	if usePerf {
		reports = append(reports, ReportSpec{
			ID:          "cpu-counters",
			Path:        statPath,
			Format:      "perf-stat-json",
			Description: "Real process-wide perf task-clock, cycles and instructions for the same workload; no cache counters.",
		})
	}
	m := Manifest{
		Version:      1,
		Issue:        "This controlled CPU demo sums the same row-major matrix in row and column traversal order. Which measured region takes longer, what cache-locality hypothesis could explain it, and what additional counters or repetitions would falsify that hypothesis? No PyTorch issue or patch is represented.",
		Captures:     []CommandSpec{capture},
		Reports:      reports,
		Verification: CommandSpec{Command: nodePath, Args: []string{script, "--verify"}, TimeoutMs: 30000},
	}
	return ValidateManifest(m)
}
