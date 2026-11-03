#!/bin/sh
# Forks a background child (sleep) that stays in the same process group,
# writes the child PID to ./fork-child.pid (relative to cwd), then sleeps.
# Used to verify that stop() sends SIGTERM to the whole process group.
# Accepts arbitrary arguments (matching the omp say arg shape) and ignores them.
sleep 999999 &
printf '%s\n' "$!" > ./fork-child.pid
sleep 999999
