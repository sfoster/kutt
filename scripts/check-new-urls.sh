#!/usr/bin/env bash
#
# check-new-urls.sh
#
# Reads the inventory tracking CSV (default: scripts/inventory.csv), sends a
# HEAD request to each row's "Static URL", and writes the HTTP status into the
# "Response Code" column. If a row's "Action" column is empty, it is filled in
# with a suggestion based on the status:
#
#   200      -> "update"   (page exists; repoint the Kutt link to it)
#   anything -> "remove"   (page is gone from source; delete the Kutt link)
#
# A non-empty "Action" is never overwritten, so manual edits are preserved
# across re-runs. The CSV is updated in place (use --out to write elsewhere).
#
# Column order is detected from the header row by name, so the columns can be
# rearranged as long as these headers exist: "Static URL", "Response Code",
# "Action".
#
# Usage:
#   ./check-new-urls.sh                         # update scripts/inventory.csv in place
#   ./check-new-urls.sh path/to/file.csv        # use a different CSV
#   ./check-new-urls.sh file.csv --out out.csv  # write result to out.csv, leave input untouched
#   ./check-new-urls.sh -q                      # quiet: only print summary + non-200 rows
#
set -uo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
CSV="scripts/inventory.csv"
OUT=""
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--quiet) QUIET=1; shift ;;
    --out)      OUT="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    -*)         echo "Unknown option: $1" >&2; exit 2 ;;
    *)          CSV="$1"; shift ;;
  esac
done

[[ -z "$OUT" ]] && OUT="$CSV"

if [[ ! -f "$CSV" ]]; then
  echo "ERROR: CSV not found: $CSV" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# HEAD request -> status code (follows redirects; prints e.g. 200 / 404 / 000)
# ---------------------------------------------------------------------------
http_status() {
  curl -sIL -o /dev/null -w '%{http_code}' \
    --connect-timeout 10 --max-time 30 --retry 2 --retry-delay 1 \
    "$1"
}

# ---------------------------------------------------------------------------
# Read CSV + locate columns by header name
# ---------------------------------------------------------------------------
mapfile -t lines < "$CSV"
if [[ ${#lines[@]} -lt 1 ]]; then
  echo "ERROR: CSV is empty: $CSV" >&2
  exit 1
fi

header="${lines[0]}"
IFS=',' read -ra cols <<< "$header"
ncols=${#cols[@]}

col_index() {
  local name="$1" i
  for i in "${!cols[@]}"; do
    [[ "${cols[$i]}" == "$name" ]] && { echo "$i"; return 0; }
  done
  return 1
}

static_idx=$(col_index "Static URL") || { echo "ERROR: no 'Static URL' column in header." >&2; exit 1; }
code_idx=$(col_index "Response Code") || { echo "ERROR: no 'Response Code' column in header." >&2; exit 1; }
action_idx=$(col_index "Action") || { echo "ERROR: no 'Action' column in header." >&2; exit 1; }

# ---------------------------------------------------------------------------
# Process rows
# ---------------------------------------------------------------------------
out=("$header")
total=0; ok=0; other=0

echo "Checking Static URLs in $CSV ..."
echo

for ((r = 1; r < ${#lines[@]}; r++)); do
  line="${lines[$r]}"
  [[ -z "$line" ]] && continue

  IFS=',' read -ra f <<< "$line"
  # pad: bash drops trailing empty fields, so restore full width
  while [[ ${#f[@]} -lt $ncols ]]; do f+=(""); done

  url="${f[$static_idx]}"
  total=$((total + 1))

  if [[ -z "$url" ]]; then
    code="ERR"
  else
    code=$(http_status "$url")
    [[ -z "$code" ]] && code="000"
  fi

  f[$code_idx]="$code"

  # only suggest an Action when the cell is empty
  if [[ -z "${f[$action_idx]}" ]]; then
    if [[ "$code" == "200" ]]; then
      f[$action_idx]="update"
    else
      f[$action_idx]="remove"
    fi
  fi

  if [[ "$code" == "200" ]]; then
    ok=$((ok + 1))
    [[ "$QUIET" -eq 0 ]] && printf '  [%s] %s -> %s\n' "$code" "$url" "${f[$action_idx]}"
  else
    other=$((other + 1))
    printf '  [%s] %s -> %s\n' "$code" "$url" "${f[$action_idx]}"
  fi

  out+=("$(IFS=','; echo "${f[*]}")")
done

# ---------------------------------------------------------------------------
# Write result
# ---------------------------------------------------------------------------
printf '%s\n' "${out[@]}" > "$OUT"

echo
echo "Summary: ${total} checked — ${ok} returned 200 (update), ${other} non-200 (remove)."
echo "Wrote: $OUT"
