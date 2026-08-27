#!/bin/bash
# run-tests.sh — verification suite for `pdf-text`.
#
#   bash skills/pdf/tests/run-tests.sh [workdir]
#
# Builds the fixtures with make-fixtures.jsh, then asserts behaviour. Exits
# non-zero if any assertion fails. Tier 2 tests are skipped automatically when no
# [ssh] exec follower is attached.

set -u
WORK="${1:-}"
if [ -z "$WORK" ]; then
  for cand in /scoops/*/tmp "$HOME/tmp" /tmp; do
    [ -d "$cand" ] && WORK="$cand/pdf-text-tests" && break
  done
fi
mkdir -p "$WORK" || { echo "cannot create workdir $WORK"; exit 1; }
cd "$WORK" || exit 1

unset PDF_TEXT_SKIP PDF_TEXT_SELFTEST PDF_TEXT_SSH_BIN
export PDF_TEXT_TMP="$WORK"

PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
has(){ printf '%s' "$2" | grep -qF -- "$3" && ok "$1" || no "$1 (missing '$3')"; }
hasnt(){ printf '%s' "$2" | grep -qF -- "$3" && no "$1 (leaked '$3')" || ok "$1"; }
rc_is(){ [ "$1" = "$2" ] && ok "$3" || no "$3 (rc=$1, want $2)"; }

echo "== fixtures =="
make-fixtures "$WORK" >/dev/null 2>&1 && ok "make-fixtures built the fixture set" || no "make-fixtures failed"
for f in simple-raw simple-flate cid-tounicode cid-nounicode fontnoise big; do
  [ -s "$f.pdf" ] || no "missing fixture $f.pdf"
done

echo
echo "== 1. the defect: pdftk dump_data_utf8 fails silently on CID w/o /ToUnicode =="
r=$(pdftk cid-nounicode.pdf dump_data_utf8 2>/dev/null); rc=$?
rc_is "$rc" 0 "pdftk exits 0 — the failure is silent"
[ -n "$r" ] && ok "pdftk prints plausible non-empty output: [$r]" || no "expected non-empty mojibake"
printf '%s' "$r" | grep -q 'PAID' && no "unexpectedly correct output" || ok "output is not the real text"

echo
echo "== 2. tier 1 extracts known text (whole ladder, then tier 1b alone) =="
for skipv in "" "1a"; do
  lbl=$([ -z "$skipv" ] && echo "1a+1b " || echo "1b-only")
  for f in simple-raw simple-flate; do
    o=$(PDF_TEXT_SKIP="$skipv" pdf-text $f.pdf --tier1-only 2>/dev/null)
    has "$lbl $f: header"    "$o" "INVOICE ACME CORP"
    has "$lbl $f: amount"    "$o" "Total Due 4242 USD"
    has "$lbl $f: TJ spacing" "$o" "Hello World Fixture"
    has "$lbl $f: line item" "$o" "Line item: Widget x3 at 14.00"
  done
  o=$(PDF_TEXT_SKIP="$skipv" pdf-text cid-tounicode.pdf --tier1-only 2>/dev/null)
  has "$lbl cid-tounicode: decoded via /ToUnicode" "$o" "PAIDYID"
done

echo
echo "== 3. garbage guard unit suite =="
if [ -f "$(dirname "$0")/guard-cases.json" ]; then
  PDF_TEXT_SELFTEST="$(cd "$(dirname "$0")" && pwd)/guard-cases.json" \
    pdf-text simple-raw.pdf >guard.json 2>/dev/null
  rc_is "$?" 0 "every guard case matched its expectation"
  node -e '
  var r=JSON.parse(require("fs").readFileSync("guard.json","utf8"));
  var rej=r.filter(function(c){return !c.expectOk;}), acc=r.filter(function(c){return c.expectOk;});
  console.log("        "+rej.filter(function(c){return !c.ok;}).length+"/"+rej.length+" garbage rejected, "
    +acc.filter(function(c){return c.ok;}).length+"/"+acc.length+" genuine accepted");
  r.filter(function(c){return c.ok!==c.expectOk;}).forEach(function(c){console.log("        MISMATCH: "+c.name);});'
else
  echo "  SKIP  guard-cases.json not found next to this script"
fi

echo
echo "== 4. the guard rejects the mojibake in situ, on every tier =="
o=$(pdf-text cid-nounicode.pdf --no-ssh 2>&1); rc=$?
rc_is "$rc" 3 "exits 3 rather than returning junk"
has  "names the rejected tier 1a"        "$o" "tier 1a (pdftk dump_data_utf8): REJECTED"
has  "names the rejected tier 1b"        "$o" "tier 1b"
has  "explains the CID/ToUnicode cause"  "$o" "subset CID font with no /ToUnicode"
hasnt "never prints the mojibake as text" "$o" '$QH'

echo
echo "== 5. a font program is never mistaken for page text =="
o=$(PDF_TEXT_SKIP=1a pdf-text fontnoise.pdf --tier1-only 2>/dev/null)
has "returns the real page text" "$o" "NET AMOUNT PAYABLE 1234.56 EUR"
for n in Copyright NotoSans "SIL Open Font" glyf hmtx; do
  hasnt "font marker absent: $n" "$o" "$n"
done

echo
echo "== 6. tier 2 degrades gracefully =="
o=$(PDF_TEXT_SSH_BIN=true PDF_TEXT_SKIP=1a,1b pdf-text simple-flate.pdf 2>&1); rc=$?
has "clear message when no follower is attached" "$o" "no ssh exec follower attached"
rc_is "$rc" 3 "no crash without a follower"

echo
echo "== 7. tier 2 real offload =="
if ssh --list 2>/dev/null | grep -q 'follower-'; then
  o=$(PDF_TEXT_SKIP=1a,1b pdf-text simple-flate.pdf --layout 2>&1)
  has "tier 2 extracted text"        "$o" "INVOICE ACME CORP"
  has "tier 2 provenance reported"   "$o" "tier 2 — poppler pdftotext"
  o=$(PDF_TEXT_SKIP=1a,1b pdf-text big.pdf --layout 2>/dev/null)
  c=$(printf '%s' "$o" | grep -c 'LEDGER SUMMARY')
  [ "$c" = "12" ] && ok "multi-chunk transfer delivered all 12 pages" || no "got $c/12 pages"
  has "last row of the last page intact" "$o" "Row 45 of page 12"
else
  echo "  SKIP  no [ssh] follower attached (see \`host\`)"
fi

echo
echo "== 8. flags and exit codes =="
c=$(pdf-text big.pdf --pages 3-4 2>/dev/null | grep -c 'LEDGER SUMMARY')
[ "$c" = "2" ] && ok "--pages 3-4 yields exactly 2 pages" || no "--pages yielded $c pages"
pdf-text big.pdf --pages 9z >/dev/null 2>&1; rc_is "$?" 1 "--pages rejects a malformed range"
o=$(pdf-text cid-nounicode.pdf --tier1-only 2>&1)
hasnt "--tier1-only does not rasterise" "$o" "Rasterised"
hasnt "--tier1-only does not touch ssh" "$o" "no ssh exec follower"
pdf-text >/dev/null 2>&1;             rc_is "$?" 1 "no arguments -> rc 1"
pdf-text ./nope.pdf >/dev/null 2>&1;  rc_is "$?" 1 "missing file -> rc 1"
pdf-text big.pdf --bogus >/dev/null 2>&1; rc_is "$?" 1 "unknown flag -> rc 1"
pdf-text simple-raw.pdf --json 2>/dev/null >j.json
node -e '
var j=JSON.parse(require("fs").readFileSync("j.json","utf8"));
process.exit(j.ok===true && j.tier==="1a" && j.text.indexOf("ACME")>=0 && Array.isArray(j.attempts) ? 0 : 1);'
rc_is "$?" 0 "--json reports ok, tier, text and attempts"

echo
echo "================ TOTAL: pass=$PASS fail=$FAIL ================"
[ "$FAIL" -eq 0 ]
