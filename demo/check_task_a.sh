#!/usr/bin/env bash
set -u

if ! command -v python >/dev/null 2>&1; then
    printf 'python was not found. Activate the Flask checkout virtual environment first.\n' >&2
    exit 2
fi

python_check='from flask.helpers import get_debug_flag; print(get_debug_flag())'
failures=0

check_value() {
    label=$1
    expected=$2
    value=$3

    actual=$(FLASK_DEBUG="$value" python -c "$python_check" 2>&1)
    status=$?
    if [ "$status" -ne 0 ] || [ "$actual" != "$expected" ]; then
        printf 'FAIL: FLASK_DEBUG=%s expected %s, got exit %s and output: %s\n' \
            "$label" "$expected" "$status" "$actual" >&2
        failures=$((failures + 1))
    else
        printf 'PASS: FLASK_DEBUG=%s -> %s\n' "$label" "$actual"
    fi
}

check_unset() {
    actual=$(env -u FLASK_DEBUG python -c "$python_check" 2>&1)
    status=$?
    if [ "$status" -ne 0 ] || [ "$actual" != "False" ]; then
        printf 'FAIL: FLASK_DEBUG unset expected False, got exit %s and output: %s\n' \
            "$status" "$actual" >&2
        failures=$((failures + 1))
    else
        printf 'PASS: FLASK_DEBUG unset -> %s\n' "$actual"
    fi
}

check_value off False off
check_value OFF False OFF
check_value n False n
check_value N False N
check_value 0 False 0
check_value false False false
check_value no False no
check_value empty False ""
check_unset
check_value 1 True 1

if [ "$failures" -ne 0 ]; then
    printf '%s Task A check(s) failed.\n' "$failures" >&2
    exit 1
fi

printf 'All Task A checks passed.\n'
