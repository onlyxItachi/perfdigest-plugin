// PROTOTYPE — NOT a replacement for the TypeScript runner.
//
// A minimal worker that executes a manifest-style command list WITHOUT a shell,
// passes only an allowlisted environment to children, SHA-256 hashes report
// files and prints a JSON receipt. It exists only so bench/run-matrix.mjs can
// compare subprocess + hashing overhead against the equivalent Node script
// (node-worker.mjs). It does no MCP, no routing, no verification semantics.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

type command struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type manifest struct {
	Version      int       `json:"version"`
	Commands     []command `json:"commands"`
	Reports      []string  `json:"reports"`
	EnvAllowlist []string  `json:"envAllowlist"`
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

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: perfdigest-worker MANIFEST.json")
	}
	start := time.Now()
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	if m.Version != 1 {
		return fmt.Errorf("unsupported manifest version %d", m.Version)
	}
	env := []string{}
	for _, key := range m.EnvAllowlist {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	out := receipt{Schema: "perfdigest.worker-receipt.v0-prototype", Worker: "go", Commands: []commandReceipt{}, Reports: []reportReceipt{}}
	for _, c := range m.Commands {
		t := time.Now()
		cmd := exec.Command(c.Command, c.Args...) // argv exec, never a shell
		cmd.Env = env
		code := 0
		if err := cmd.Run(); err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			} else {
				return err
			}
		}
		out.Commands = append(out.Commands, commandReceipt{Argv: append([]string{c.Command}, c.Args...), ExitCode: code, ElapsedMs: ms(time.Since(t))})
	}
	for _, p := range m.Reports {
		r, err := hashFile(p)
		if err != nil {
			return err
		}
		out.Reports = append(out.Reports, r)
	}
	out.TotalMs = ms(time.Since(start))
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(out)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
