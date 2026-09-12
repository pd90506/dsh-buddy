#!/usr/bin/env python3
"""Regression matrix for the no-broad-scan hook.

Run: python3 .claude/hooks/test-deny-broad-scans.py

The allow cases matter as much as the deny cases. An over-strict guard is one
someone switches off: the first version of this hook blocked the very commit
that introduced it, because its message NAMED the mount paths inside a heredoc.
The path literals below are assembled from fragments so that running this file
through a shell never trips the live hook with its own fixtures.
"""
import json, subprocess, sys, pathlib

NAS = "/mnt/" + "nas"
HOOK = str(pathlib.Path(__file__).with_name("deny-broad-scans.sh"))

CASES = [
    ("deny", 'find / -name "*.ts"', "find rooted at /"),
    ("deny", "find ~ -type f", "find rooted at ~"),
    ("deny", "cd /tmp && find / -name x", "find / after a chained cd"),
    ("deny", "du -sh /", "du rooted at /"),
    ("deny", "ls -R ~", "recursive ls rooted at ~"),
    ("deny", "grep -r pattern /", "grep -r rooted at /"),
    ("deny", "rg foo $HOME", "rg rooted at $HOME"),
    ("deny", f"ls {NAS}", "listing the NAS"),
    ("deny", f'cat "{NAS}/x"', "quoted NAS path is still a real read"),
    ("deny", f"rsync -a {NAS}/backup .", "pulling from the NAS"),
    ("allow", "ls /", "one-level ls of / is not a scan"),
    ("allow", "ls ~", "one-level ls of ~ is not a scan"),
    ("allow", 'find src -name "*.ts"', "find into a specific directory"),
    ("allow", "find node_modules/@deepseek-ai -maxdepth 2 -name package.json", "find into a named package tree"),
    ("allow", "grep -rn buddySoul src/", "recursive grep into a specific directory"),
    ("allow", "rg persona test/", "rg into a specific directory"),
    ("allow", "npm run check", "an ordinary build command"),
    ("allow", "du -sh node_modules", "du of a named directory"),
    ("allow", f"cat >> l.md <<'EOF'\nnever run find / or touch {NAS}\nEOF", "heredoc that documents the paths"),
]


def main() -> int:
    failures = 0
    for want, cmd, label in CASES:
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
        out = subprocess.run(["bash", HOOK], input=payload, capture_output=True, text=True).stdout.strip()
        got = "deny" if out else "allow"
        if got != want:
            failures += 1
        print(f"{'OK  ' if got == want else 'FAIL'} want={want:5} got={got:5} | {label}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
