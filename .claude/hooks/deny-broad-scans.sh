#!/usr/bin/env bash
# Deny filesystem-wide scans and any access to the network/backup volumes.
#
# Prefix-matching permission rules cannot express this: they anchor at the start
# of the command, so `cd /tmp && find /` or a mount path in argument position
# walks straight past them. This reads the whole command string instead.
#
# The constraint is the user's, recorded in CLAUDE.md: a traversal that wanders
# into the NAS runs for HOURS over NFS before it returns. Prompt-level
# instruction failed twice with subagents, hence enforcement here.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0

# Heredoc bodies are documentation, not access. Writing a commit message or a
# ledger entry that NAMES these paths must not be refused — the first version of
# this hook blocked its own commit that way, and a guard that obstructs ordinary
# work is a guard someone turns off. Quoted strings are deliberately NOT
# stripped: `cat "/mnt/nas/x"` is a real read and must still be caught.
scan=$(printf '%s' "$cmd" | awk '
	BEGIN { skip = 0 }
	skip == 1 { if ($0 == term) skip = 0; next }
	{
		line = $0
		if (match(line, /<<-?[[:space:]]*'"'"'?[A-Za-z_][A-Za-z0-9_]*'"'"'?/)) {
			term = substr(line, RSTART, RLENGTH)
			gsub(/^<<-?[[:space:]]*|'"'"'/, "", term)
			skip = 1
		}
		print line
	}')

deny() {
	jq -nc --arg reason "$1" '{
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: $reason
		}
	}'
	exit 0
}

# The network and backup volumes: enormous and slow, so any real reference is
# refused rather than judged. If a task genuinely needs a named file on one,
# the user runs the command themselves.
if printf '%s' "$scan" | grep -qE '(/mnt/nas|/srv/timemachine)'; then
	deny "Blocked by .claude/hooks/deny-broad-scans.sh: this command touches the NAS or Time Machine volume. A traversal there runs for hours. If you genuinely need a named file on one of them, ask the user to run the command themselves."
fi

# Recursive readers pointed at a filesystem root. Only inherently recursive
# forms are listed: `ls /` and `ls ~` are one level and stay allowed, while
# `find`, `fd`, `rg`, `du` and `ls -R` all descend without being asked twice.
root='(/|~|\$HOME|"\$HOME")'
if printf '%s' "$scan" | grep -qE "(^|[;&|]|&&|\|\|)[[:space:]]*(sudo[[:space:]]+)?(find|fd)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*${root}([[:space:]]|$)"; then
	deny "Blocked by .claude/hooks/deny-broad-scans.sh: this is a find/fd rooted at the filesystem root or the home directory — a whole-filesystem scan. Recursing into a SPECIFIC directory you have a reason to search is fine; the rule is about the starting point, not the depth. See the hard constraints in CLAUDE.md."
fi
if printf '%s' "$scan" | grep -qE "(^|[;&|]|&&|\|\|)[[:space:]]*(sudo[[:space:]]+)?(du|ls[[:space:]]+-[a-zA-Z]*R[a-zA-Z]*|grep[[:space:]]+(-[^[:space:]]*[rR][^[:space:]]*[[:space:]]+)|rg)([^;&|]*[[:space:]])?${root}([[:space:]]|$)"; then
	deny "Blocked by .claude/hooks/deny-broad-scans.sh: this is a recursive read (du / ls -R / grep -r / rg) rooted at the filesystem root or the home directory. Point it at a specific directory instead. See the hard constraints in CLAUDE.md."
fi
exit 0
