#!/usr/bin/env python3
"""
Cyber Boss — Proactive trigger script.

Sends a message to the user via Feishu Bot API, which triggers
the OpenClaw Cyber Boss agent to perform morning standup or evening review.

Usage:
    # Morning standup (cron: 0 9 * * 1-5)
    python3 cyber-boss-trigger.py morning

    # Evening review (cron: 0 21 * * 1-5)
    python3 cyber-boss-trigger.py evening

Environment variables (required):
    FEISHU_APP_ID       - Cyber Boss bot app ID
    FEISHU_APP_SECRET   - Cyber Boss bot app secret
    FEISHU_USER_OPEN_ID - Target user's open_id
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
FEISHU_MSG_URL = "https://open.feishu.cn/open-apis/im/v1/messages"

MESSAGES = {
    "morning": "老板，开始今天工作",
    "evening": "汇报进度",
    "weekly": "老板，周日复盘",
}


def get_tenant_token(app_id: str, app_secret: str) -> str:
    payload = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(
        FEISHU_TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"Failed to get token: {data}")
    return data["tenant_access_token"]


def send_message(token: str, open_id: str, text: str) -> dict:
    payload = json.dumps({
        "receive_id": open_id,
        "msg_type": "text",
        "content": json.dumps({"text": text}),
    }).encode()
    req = urllib.request.Request(
        f"{FEISHU_MSG_URL}?receive_id_type=open_id",
        data=payload,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"Failed to send message: {data}")
    return data


def main():
    parser = argparse.ArgumentParser(description="Cyber Boss proactive trigger")
    parser.add_argument(
        "action",
        choices=list(MESSAGES.keys()),
        help="Which trigger to fire",
    )
    args = parser.parse_args()

    app_id = os.environ.get("FEISHU_APP_ID")
    app_secret = os.environ.get("FEISHU_APP_SECRET")
    user_open_id = os.environ.get("FEISHU_USER_OPEN_ID")

    missing = []
    if not app_id:
        missing.append("FEISHU_APP_ID")
    if not app_secret:
        missing.append("FEISHU_APP_SECRET")
    if not user_open_id:
        missing.append("FEISHU_USER_OPEN_ID")
    if missing:
        print(f"Error: missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    text = MESSAGES[args.action]
    print(f"[cyber-boss-trigger] action={args.action}, text={text!r}")

    token = get_tenant_token(app_id, app_secret)
    result = send_message(token, user_open_id, text)
    print(f"[cyber-boss-trigger] sent OK: message_id={result.get('data', {}).get('message_id', 'unknown')}")


if __name__ == "__main__":
    main()
