#!/usr/bin/env bash
set -u

if [ -z "${FORGELENS_DEMO_APP:-}" ]; then
    printf 'Set FORGELENS_DEMO_APP to the absolute path of demo_app.py.\n' >&2
    exit 2
fi

if [ ! -f "$FORGELENS_DEMO_APP" ]; then
    printf 'Demo app not found: %s\n' "$FORGELENS_DEMO_APP" >&2
    exit 2
fi

if ! command -v flask >/dev/null 2>&1 || ! command -v python >/dev/null 2>&1; then
    printf 'flask or python was not found. Activate the Flask checkout virtual environment first.\n' >&2
    exit 2
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/forgelens-task-b.XXXXXX") || {
    printf 'Could not create a temporary directory.\n' >&2
    exit 2
}

cleanup() {
    rm -f "$tmpdir/config.stdout" "$tmpdir/config.stderr" \
        "$tmpdir/help.stdout" "$tmpdir/help.stderr" \
        "$tmpdir/pytest.stdout" "$tmpdir/pytest.stderr"
    rmdir "$tmpdir"
}
trap cleanup EXIT

flask --app "$FORGELENS_DEMO_APP:app" config \
    >"$tmpdir/config.stdout" 2>"$tmpdir/config.stderr"
config_status=$?
if [ "$config_status" -ne 0 ]; then
    printf 'FAIL: flask config exited with %s.\n' "$config_status" >&2
    cat "$tmpdir/config.stderr" >&2
    exit 1
fi

if ! python - "$tmpdir/config.stdout" "$tmpdir/config.stderr" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as output_file:
    output = output_file.read()
with open(sys.argv[2], encoding="utf-8") as error_file:
    error_output = error_file.read()

try:
    config = json.loads(output)
except json.JSONDecodeError as error:
    raise SystemExit(f"FAIL: flask config did not print valid JSON: {error}")

if not isinstance(config, dict):
    raise SystemExit("FAIL: flask config JSON must be an object.")
if config.get("DEMO_REGION") != "west":
    raise SystemExit('FAIL: DEMO_REGION must be "west".')
if "PERMANENT_SESSION_LIFETIME" not in config:
    raise SystemExit("FAIL: JSON output is missing PERMANENT_SESSION_LIFETIME.")

masked_keys = (
    "APP_SECRET",
    "DATABASE_PASSWORD",
    "SERVICE_TOKEN",
    "API_KEY",
)
for key in masked_keys:
    if config.get(key) != "***":
        raise SystemExit(f"FAIL: {key} must be masked as ***.")

combined_output = output + error_output
fake_values = ("fake-secret", "fake-password", "demo-only", "fake-key")
for value in fake_values:
    if value in combined_output:
        raise SystemExit("FAIL: a fake sensitive value appeared in command output.")

print("PASS: config output is valid JSON, expected values are present, secrets are masked, and the timedelta default is serializable.")
PY
then
    cat "$tmpdir/config.stdout"
    cat "$tmpdir/config.stderr" >&2
    exit 1
fi

flask --help >"$tmpdir/help.stdout" 2>"$tmpdir/help.stderr"
help_status=$?
if [ "$help_status" -ne 0 ]; then
    printf 'FAIL: flask --help exited with %s.\n' "$help_status" >&2
    cat "$tmpdir/help.stderr" >&2
    exit 1
fi
if ! grep -Eq '(^|[[:space:]])config([[:space:]]|$)' "$tmpdir/help.stdout"; then
    printf 'FAIL: flask --help does not list the config command.\n' >&2
    exit 1
fi
printf 'PASS: flask --help lists config.\n'

pytest tests/test_cli.py -q >"$tmpdir/pytest.stdout" 2>"$tmpdir/pytest.stderr"
pytest_status=$?
if [ "$pytest_status" -ne 0 ]; then
    printf 'FAIL: pytest tests/test_cli.py -q exited with %s.\n' "$pytest_status" >&2
    cat "$tmpdir/pytest.stdout"
    cat "$tmpdir/pytest.stderr" >&2
    exit 1
fi
cat "$tmpdir/pytest.stdout"
cat "$tmpdir/pytest.stderr" >&2
printf 'All Task B checks passed.\n'
