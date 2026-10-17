"""Checks reference artifacts only, not the Worker runtime or live D1."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import json, re, sqlite3
ROOT=Path(__file__).resolve().parents[1]
checks=[]
def record(name): checks.append(name)
def expect_constraint(fn):
    try: fn()
    except sqlite3.IntegrityError: return
    raise AssertionError('Expected an integrity constraint failure')
IGNORED_PARTS={'.git','.private','node_modules','.pnpm-store','.wrangler','.superpowers','dist','coverage'}
def project_files(pattern):
    return (p for p in ROOT.rglob(pattern) if not IGNORED_PARTS.intersection(p.relative_to(ROOT).parts))
for p in project_files('*.json'): json.loads(p.read_text())
record('All standalone JSON files parse')
for p in project_files('*.md'):
    text=p.read_text()
    assert len(re.findall(r'^```',text,re.M))%2 == 0, p
    for block in re.findall(r'^```json\s*\n(.*?)^```',text,re.M|re.S): json.loads(block)
record('Markdown fences and JSON examples parse')
cfg=json.loads((ROOT/'reference/app.config.example.json').read_text())
assert cfg['timezone']=='Asia/Shanghai' and cfg['delivery']['channel']=='dummy'
assert cfg['llm']['inputMicrousdPerMillionTokens'] is None
assert cfg['budget']=={'dayMicrousd':750000,'monthMicrousd':15000000}
record('Example configuration prevents paid calls and real delivery')
from_fields={'id','name','kind','url','enabled','core','priority','allowedHosts','intervalHours','verification','browserFallbackEnabled','upgradeHttpLinks','github','html','authority'}
sources=json.loads((ROOT/'reference/sources.example.json').read_text())['sources']
assert len({s['id'] for s in sources})==len(sources)
for s in sources:
    assert set(s)<=from_fields and not s['enabled'] and s['verification']=='discovered'
    assert s['kind'] in ['rss','github_releases','html_list']
record('Source registry matches the declared contract and is disabled by default')
c=sqlite3.connect(':memory:')
c.executescript((ROOT/'reference/schema.sql').read_text())
tables=c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
assert len(tables)==18, tables
record('Reference migration creates all 18 tables in SQLite')
c.execute("INSERT INTO sources(id,kind,name,url,config_json,config_hash,created_at,updated_at) VALUES('s','rss','s','https://example.com','{}','h',1,1)")
c.execute("INSERT INTO runs(id,job_key,workflow_id,kind,state,source_id,scheduled_at,deadline_at,params_json,created_at,updated_at) VALUES('r','j','w','collect','running','s',1,100,'{}',1,1)")
c.execute("INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status) VALUES('r',0,'null','committed')")
c.execute("INSERT INTO items VALUES('i','s','external','https://example.com/a',1,1,0)")
for rev,h in enumerate(['A','B','A'],1):
    c.execute("INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",(f'v{rev}','i',rev,f'ingest-{rev}','r',0,h,'Title','https://example.com/a',rev,h,'full','{}'))
assert c.execute('SELECT COUNT(*) FROM item_versions').fetchone()[0]==3
record('A to B to A can be represented as three immutable revisions')
expect_constraint(lambda:c.execute("INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json) VALUES('bad','i',4,'ingest-3','r',0,'C','T','https://example.com',4,'C','full','{}')"))
record('A replayed ingest key cannot add a duplicate revision')
expect_constraint(lambda:c.execute("INSERT INTO items VALUES('i2','s','external','https://example.com/b',1,1,0)"))
record('Source item external identity is unique')
base=('d','personal','2026-09-21','Asia/Shanghai','scheduled','collecting',0,10,20,30,40,'{}',1,1)
sql='INSERT INTO digests(id,profile_id,local_date,timezone,mode,status,window_start_at,cutoff_at,build_deadline_at,send_at,send_deadline_at,config_snapshot_json,created_at,updated_at) VALUES('+','.join('?'*len(base))+')'
c.execute(sql,base)
expect_constraint(lambda:c.execute(sql,('d2',)+base[1:]))
c.execute(sql,('p',)+base[1:4]+('preview',)+base[5:])
record('Scheduled uniqueness does not block independent previews')
for slot in range(5):
    c.execute('INSERT INTO request_keys VALUES(?,?,?,?,?,?,?,?)',('preview',str(slot),'hash','r',1,100,1,slot))
expect_constraint(lambda:c.execute('INSERT INTO request_keys VALUES(?,?,?,?,?,?,?,?)',('preview','six','hash','r',1,100,1,5)))
record('The request rate bucket has only five valid slots')
expect_constraint(lambda:c.execute("INSERT INTO budget_buckets VALUES('bad',1,-1,0,1)"))
record('Budget amounts cannot be negative')
assert not c.execute('PRAGMA foreign_key_check').fetchall()
record('Reference fixture respects foreign keys')
c.execute("UPDATE collection_pages SET committed_at=3 WHERE run_id='r' AND page_no=0")
c.execute("INSERT INTO collection_pages(run_id,page_no,request_cursor_json,status) VALUES('r',1,'null','pending')")
c.execute("INSERT INTO item_versions(id,item_id,revision,ingest_key,collection_run_id,collection_page_no,content_hash,title,canonical_url,ingested_at,body_text,quality,metadata_json) VALUES('staged','i',4,'stage-4','r',1,'C','T','https://example.com',4,'C','full','{}')")
freeze_sql="""SELECT v.id FROM item_versions v JOIN collection_pages p
ON p.run_id=v.collection_run_id AND p.page_no=v.collection_page_no
WHERE v.item_id='i' AND v.ingested_at<=10 AND p.status='committed'
AND p.committed_at<=10 ORDER BY v.revision DESC LIMIT 1"""
assert c.execute(freeze_sql).fetchone()[0]=='v3'
record('Pending page versions are excluded from the frozen candidate query')
c.execute("UPDATE collection_pages SET status='committed',committed_at=11 WHERE run_id='r' AND page_no=1")
assert c.execute(freeze_sql).fetchone()[0]=='v3'
record('A page finalized after cutoff stays out even if its rows were staged earlier')

t=datetime.fromisoformat('2026-09-20T23:45:00+00:00').astimezone(ZoneInfo('Asia/Shanghai'))
assert t.strftime('%Y-%m-%d %H:%M')=='2026-09-21 07:45'
record('UTC morning trigger maps to the next local date')
# Exercise the exact illustrative budget SQL against the reference schema.
reliability=(ROOT/'docs/05-reliability.md').read_text()
blocks=re.findall(r'^```sql\s*\n(.*?)^```',reliability,re.M|re.S)
budget=next(b for b in blocks if b.lstrip().startswith('-- E.'))
statements=[]; acc=''
for line in budget.splitlines(True):
    acc+=line
    if sqlite3.complete_statement(acc):
        statements.append(acc); acc=''
params=dict(day_bucket='2026-09-21',month_bucket='2026-09',day_limit=750000,
    month_limit=15000000,now=10,call_id='call-a',cache_key='cache-a',
    invocation_id='invocation-a',generation=0,deadline_at=100,attempt_no=1,
    digest_id='d',stage='filter',model='test-model',prompt_version='digest-v1',reservation=600000)
c.commit()
def execute_budget(values):
    with c:
        for statement in statements: c.execute(statement, values)
execute_budget(params)
assert c.execute("SELECT reserved_microusd FROM budget_buckets WHERE bucket_key='2026-09-21'").fetchone()[0]==600000
expect_constraint(lambda:execute_budget(params))
assert c.execute("SELECT reserved_microusd FROM budget_buckets WHERE bucket_key='2026-09-21'").fetchone()[0]==600000
record('Documented budget SQL executes and replay does not double-reserve')
second=dict(params,call_id='call-b',invocation_id='invocation-b',cache_key='cache-b')
expect_constraint(lambda:execute_budget(second))
assert c.execute("SELECT COUNT(*) FROM llm_calls").fetchone()[0]==1
record('Documented budget SQL rejects insufficient daily funds atomically')
for name in checks: print('PASS:',name)
print(f'{len(checks)} reference checks passed. Not an application, D1-runtime, or deployment test.')
