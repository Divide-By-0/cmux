#!/usr/bin/env python3
"""Check that an existing live tab's displayed title reaches the real FTS index.

Both CMUX_SOCKET_PATH and CMUX_SEARCH_DB must be explicit. This check is
read-only and works against a release app as well as an isolated debug build.
Open Global Search once to refresh its index before running this probe.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3

from cmux import cmux


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--title', required=True)
    parser.add_argument('--query', required=True)
    args = parser.parse_args()
    socket_path = os.environ['CMUX_SOCKET_PATH']
    database = Path(os.environ['CMUX_SEARCH_DB']).resolve()
    with cmux(socket_path) as client:
        tree = client._call('system.tree', {})
    matches = [s for window in tree['windows'] for workspace in window['workspaces']
               for pane in workspace['panes'] for s in pane['surfaces']
               if s['type'] == 'terminal' and s['title'] == args.title]
    assert len(matches) == 1, 'expected exactly one live terminal with the requested displayed title'
    panel_id = matches[0]['id']
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True) as db:
        rows = db.execute("SELECT title FROM chunks WHERE panel_id = ? COLLATE NOCASE AND kind = 'title'",
                          (panel_id,)).fetchall()
        assert rows and all(row[0] == args.title for row in rows), \
            'displayed title %r is indexed as %r' % (args.title, rows)
        query = '"'+args.query.replace('"', '""')+'"'
        hits = db.execute('SELECT c.panel_id FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid '
                          'WHERE chunks_fts MATCH ?', (query,)).fetchall()
        assert any(row[0].lower() == panel_id.lower() for row in hits), \
            'FTS query must find the terminal by its displayed title'
    print(json.dumps({'result': 'PASS', 'title': args.title, 'query': args.query, 'panel_id': panel_id}))


if __name__ == '__main__':
    main()
