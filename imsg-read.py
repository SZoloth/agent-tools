#!/usr/bin/env python3
"""
Read iMessage content including modern messages stored in attributedBody.
Usage: imsg-read.py [--contact PHONE] [--search TERM] [--days N] [--limit N]
"""
import sqlite3
import argparse
import os
from datetime import datetime, timedelta

DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")

def decode_attributed_body(blob: bytes) -> str:
    """Extract plain text from NSAttributedString archive."""
    if not blob:
        return ""
    try:
        text = blob.decode('utf-8', errors='ignore')

        # Method 1: Look for + length prefix (works for both formats)
        if '+' in text:
            idx = text.find('+')
            raw = text[idx+1:idx+1000]

            # Pattern A: Long message - starts with 0x81 (variable length marker)
            if raw and ord(raw[0]) == 0x81:
                # Skip 0x81 + length byte + null separator
                chunk = raw[3:] if len(raw) > 3 else ""
            # Pattern B: Short message - single byte length
            elif raw and ord(raw[0]) < 128:
                chunk = raw[1:]  # Skip the length byte
            else:
                chunk = raw

            # Cut at metadata markers
            cutoffs = ['__kIM', 'NSNumber', 'NSValue', 'NSDictionary', '\x02', '\x86']
            for cutoff in cutoffs:
                if cutoff in chunk:
                    chunk = chunk[:chunk.find(cutoff)]

            # Remove leading lowercase if followed by uppercase (artifact)
            if len(chunk) > 2 and chunk[0].islower() and chunk[1].isupper():
                chunk = chunk[1:]

            chunk = chunk.strip()
            if len(chunk) > 3:
                return chunk

        # Method 2: streamtyped format (older NSArchiver)
        if 'streamtyped' in text:
            # Text appears after NSString or in readable sections
            import re
            # Find longest sequence of printable chars that looks like a message
            # Skip the header/metadata parts
            parts = text.split('NSString')
            for part in parts[1:]:  # Skip first part (header)
                # Extract readable text
                readable = ''.join(c for c in part if c.isprintable())
                # Clean metadata
                for marker in ['NSMutableString', 'NSDictionary', 'NSNumber', 'NSValue', 'NSObject', 'NSData', 'i', 'I']:
                    readable = readable.replace(marker, ' ')
                readable = ' '.join(readable.split()).strip()
                if len(readable) > 10 and not readable.startswith('+'):
                    return readable[:500]

            # Fallback: find URL or other content
            urls = re.findall(r'https?://[^\s\x00]+', text)
            if urls:
                return urls[0]

        return ""
    except:
        return ""

def get_messages(contact=None, search=None, days=30, limit=50):
    """Query messages with text OR attributedBody content."""
    conn = sqlite3.connect(DB_PATH)

    # Calculate date threshold (Apple's epoch is 2001-01-01)
    threshold = datetime.now() - timedelta(days=days)
    apple_epoch = datetime(2001, 1, 1)
    ns_threshold = (threshold - apple_epoch).total_seconds() * 1_000_000_000

    query = """
        SELECT
            datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as date,
            h.id as contact,
            h.service,
            m.is_from_me,
            m.text,
            m.attributedBody
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.date > ?
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
    """
    params = [ns_threshold]

    if contact:
        query += " AND h.id LIKE ?"
        params.append(f"%{contact}%")

    query += " ORDER BY m.date DESC LIMIT ?"
    params.append(limit)

    cursor = conn.execute(query, params)
    results = []

    for row in cursor:
        date, contact_id, service, is_from_me, text, attr_body = row

        # Get content from text or decode attributedBody
        content = text if text else decode_attributed_body(attr_body)

        if not content:
            continue

        # Apply search filter
        if search and search.lower() not in content.lower():
            continue

        results.append({
            'date': date,
            'contact': contact_id,
            'service': service,
            'from_me': bool(is_from_me),
            'text': content
        })

    conn.close()
    return results

def main():
    parser = argparse.ArgumentParser(description='Read iMessages including RCS/modern format')
    parser.add_argument('--contact', '-c', help='Filter by contact (phone/email partial match)')
    parser.add_argument('--search', '-s', help='Search message content')
    parser.add_argument('--days', '-d', type=int, default=30, help='Days back to search (default: 30)')
    parser.add_argument('--limit', '-n', type=int, default=50, help='Max results (default: 50)')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()

    messages = get_messages(
        contact=args.contact,
        search=args.search,
        days=args.days,
        limit=args.limit
    )

    if args.json:
        import json
        print(json.dumps(messages, indent=2))
    else:
        for msg in messages:
            direction = "→" if msg['from_me'] else "←"
            service = f"[{msg['service']}]" if msg['service'] != 'iMessage' else ""
            print(f"{msg['date']} {direction} {msg['contact']} {service}")
            print(f"  {msg['text'][:200]}")
            print()

if __name__ == "__main__":
    main()
