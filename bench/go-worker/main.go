// PROTOTYPE — NOT a replacement for the TypeScript runner.
//
// A minimal worker that executes a manifest-style command list WITHOUT a shell,
// passes only an allowlisted environment to children, SHA-256 hashes report
// files and prints a JSON receipt. It exists only so benchmarks can compare
// subprocess + hashing overhead against equivalent Node/Bun/Deno scripts.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type command struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type reportOrPath struct {
	Path string
}

func (r *reportOrPath) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		r.Path = s
		return nil
	}
	var obj struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(data, &obj); err == nil {
		r.Path = obj.Path
		return nil
	}
	return fmt.Errorf("invalid report: %s", string(data))
}

type manifest struct {
	Version      int            `json:"version"`
	Commands     []command      `json:"commands"`
	Reports      []reportOrPath `json:"reports"`
	EnvAllowlist []string       `json:"envAllowlist"`
}

type commandReceipt struct {
	Argv      []string `json:"argv"`
	ExitCode  int      `json:"exitCode"`
	ElapsedMs float64  `json:"elapsedMs"`
}

type reportReceipt struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type receipt struct {
	Schema   string           `json:"schema"`
	Worker   string           `json:"worker"`
	Commands []commandReceipt `json:"commands"`
	Reports  []reportReceipt  `json:"reports"`
	TotalMs  float64          `json:"totalMs"`
}

type jobRequest struct {
	Manifest  string `json:"manifest"`
	Workspace string `json:"workspace"`
	Out       string `json:"out"`
}

type jobResponse struct {
	Ok        bool   `json:"ok"`
	ElapsedUs int64  `json:"elapsedUs"`
	Reports   int    `json:"reports"`
	Out       string `json:"out"`
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func hashFile(path string) (reportReceipt, error) {
	f, err := os.Open(path)
	if err != nil {
		return reportReceipt{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return reportReceipt{}, err
	}
	return reportReceipt{Path: path, SHA256: hex.EncodeToString(h.Sum(nil)), Bytes: n}, nil
}

func executeJob(req jobRequest) (receipt, int64, error) {
	start := time.Now()
	raw, err := os.ReadFile(req.Manifest)
	if err != nil {
		return receipt{}, 0, err
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return receipt{}, 0, err
	}
	if m.Version != 1 {
		return receipt{}, 0, fmt.Errorf("unsupported manifest version %d", m.Version)
	}
	env := []string{}
	for _, key := range m.EnvAllowlist {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	out := receipt{
		Schema:   "perfdigest.worker-receipt.v0-prototype",
		Worker:   "go",
		Commands: []commandReceipt{},
		Reports:  []reportReceipt{},
	}
	for _, c := range m.Commands {
		t := time.Now()
		cmd := exec.Command(c.Command, c.Args...)
		cmd.Env = env
		if req.Workspace != "" {
			cmd.Dir = req.Workspace
		}
		code := 0
		if err := cmd.Run(); err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			} else {
				return receipt{}, 0, err
			}
		}
		out.Commands = append(out.Commands, commandReceipt{
			Argv:      append([]string{c.Command}, c.Args...),
			ExitCode:  code,
			ElapsedMs: ms(time.Since(t)),
		})
	}
	for _, p := range m.Reports {
		reportPath := p.Path
		if req.Workspace != "" && !filepath.IsAbs(reportPath) {
			reportPath = filepath.Join(req.Workspace, reportPath)
		}
		r, err := hashFile(reportPath)
		if err != nil {
			return receipt{}, 0, err
		}
		out.Reports = append(out.Reports, r)
	}
	elapsedUs := time.Since(start).Microseconds()
	out.TotalMs = ms(time.Since(start))
	if req.Out != "" {
		data, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return receipt{}, 0, err
		}
		if err := os.WriteFile(req.Out, append(data, '\n'), 0600); err != nil {
			return receipt{}, 0, err
		}
	}
	return out, elapsedUs, nil
}

func runServe() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	enc := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req jobRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintf(os.Stderr, "json unmarshal error: %v\n", err)
			continue
		}
		rec, elapsedUs, err := executeJob(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "execute job error: %v\n", err)
			continue
		}
		resp := jobResponse{
			Ok:        true,
			ElapsedUs: elapsedUs,
			Reports:   len(rec.Reports),
			Out:       req.Out,
		}
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func runOneShot() error {
	var manifestPath, workspace, outPath string
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		if arg == "--manifest" && i+1 < len(os.Args) {
			manifestPath = os.Args[i+1]
			i++
		} else if arg == "--workspace" && i+1 < len(os.Args) {
			workspace = os.Args[i+1]
			i++
		} else if arg == "--out" && i+1 < len(os.Args) {
			outPath = os.Args[i+1]
			i++
		} else if !strings.HasPrefix(arg, "-") && manifestPath == "" {
			manifestPath = arg
		}
	}
	if manifestPath == "" {
		return fmt.Errorf("usage: perfdigest-worker [--serve] [--manifest <path>] [--workspace <dir>] [--out <file>] [MANIFEST.json]")
	}
	rec, _, err := executeJob(jobRequest{Manifest: manifestPath, Workspace: workspace, Out: outPath})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(rec)
}

func main() {
	for _, arg := range os.Args[1:] {
		if arg == "--serve" {
			if err := runServe(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		}
	}
	if err := runOneShot(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
