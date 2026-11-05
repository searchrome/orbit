#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/collect-sellers-v2.js"
LOG_DIR="$ROOT_DIR/scripts/logs"
STATE_FILE="$LOG_DIR/seller_leads_v2_state.json"
MERGE_SCRIPT="$ROOT_DIR/scripts/merge-seller-leads-v2.js"

PAGES="${PAGES:-100}"
VISIT_LIMIT="${VISIT_LIMIT:-350}"
DELAY="${DELAY:-1500}"
PORT="${CDP_PORT:-9222}"

# Categories ordered by relevance to checklot.nl
CATEGORIES=(
    antiek-en-kunst
    sieraden
    verzamelen
    munten-en-biljetten
    postzegels
    meubels
    audio-tv-en-foto
    computers-en-software
)

mkdir -p "$LOG_DIR"

echo "=========================================="
echo " Marktplaats Seller Collector - All Categories"
echo "=========================================="
echo "Pages per category: $PAGES"
echo "Visit limit per category: $VISIT_LIMIT"
echo "Delay: ${DELAY}ms"
echo "CDP port: $PORT"
echo "State file: $STATE_FILE"
echo "Categories: ${CATEGORIES[*]}"
echo "=========================================="
echo ""

# Check browser is running
if ! curl -fsS "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1; then
    echo "[ERROR] Browser not running on port $PORT. Start it first:"
    echo "  npm start -- --remote-debugging-port=$PORT"
    exit 1
fi

TOTAL_START=$(date +%s)
COMPLETED=0
FAILED=0

for CATEGORY in "${CATEGORIES[@]}"; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Category: $CATEGORY ($(( COMPLETED + 1 ))/${#CATEGORIES[@]})"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Started: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    LOG_FILE="$LOG_DIR/run_${CATEGORY}_$(date +%Y%m%d-%H%M%S).log"

    if node "$SCRIPT" \
        --categories "$CATEGORY" \
        --pages "$PAGES" \
        --visit-limit "$VISIT_LIMIT" \
        --delay "$DELAY" \
        --port "$PORT" \
        --resume-state "$STATE_FILE" \
        --format json \
        2>&1 | tee "$LOG_FILE"; then
        COMPLETED=$(( COMPLETED + 1 ))
        echo ""
        echo "[OK] $CATEGORY finished ($(( COMPLETED ))/${#CATEGORIES[@]} done)"
    else
        FAILED=$(( FAILED + 1 ))
        echo ""
        echo "[WARN] $CATEGORY failed — continuing with next category"
    fi

    # Brief pause between categories to avoid rate limiting
    if [[ $COMPLETED -lt ${#CATEGORIES[@]} ]]; then
        echo "[wait] Cooling down 5s before next category..."
        sleep 5
    fi
done

TOTAL_END=$(date +%s)
ELAPSED=$(( TOTAL_END - TOTAL_START ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

echo ""
echo "=========================================="
echo " All categories complete"
echo "=========================================="
echo " Completed: $COMPLETED / ${#CATEGORIES[@]}"
echo " Failed: $FAILED"
echo " Total time: ${MINS}m ${SECS}s"
echo "=========================================="

# Merge all results
echo ""
echo "Merging all leads..."
node "$MERGE_SCRIPT" 2>&1

echo ""
echo "Done! Check scripts/logs/ for results."
