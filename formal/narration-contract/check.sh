#!/bin/sh
set -eu
exec python3 -I "$(dirname "$0")/check.py" "$@"
