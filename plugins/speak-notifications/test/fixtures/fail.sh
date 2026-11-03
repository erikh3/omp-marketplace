#!/bin/sh
# Writes a diagnostic message to stderr and exits with code 1.
# Accepts arbitrary arguments (matching the omp say arg shape) and ignores them.
echo "synthesis error: device not found" >&2
exit 1
