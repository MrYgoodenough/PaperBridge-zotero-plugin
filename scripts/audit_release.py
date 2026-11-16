"""Read-only release audit. Findings contain locations, never matched secret values."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    'github_token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
    'provider_key': rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}',
    'aws_access_key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'google_api_key': rb'\bAIza[0-9A-Za-z_-]{35}\b',
    'slack_token': rb'\bxox[baprs]-[0-9A-Za-z-]{20,}',
    'private_key_block': rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    'credential_in_url': rb'https?://[^\s/:@"\x27]{2,}:[^\s/@"\x27]{8,}@[^\s/"\x27]+',
}
ASSIGNMENT = re.compile(rb'(?i)\b(?:api[_-]?key|access[_-]?token|secret|password)\b["\x27]?\s*[:=]\s*["\x27]([^"\x27\r\n]{8,})["\x27]')
EXCLUDED_FILES = {'translations.json','usage.json','service.json','token','logins.json','key4.db','cookies.sqlite','places.sqlite','.zotero-reader-state'}
EXCLUDED_PARTS = {'.git','.env','.runtime','.venv','__pycache__','tests','packaged-data','formula-cache'}


def known_secrets():
    values=[]
    env=ROOT/'.env'
    if env.exists():
        for line in env.read_text().splitlines():
            match=re.match(r'\s*([\w]+)\s*=\s*(.*?)\s*$',line)
            if match and re.search(r'key|token|secret|password',match[1],re.I):
                value=match[2].strip('\"\x27')
                if len(value)>=12:values.append(value.encode())
    for name in ('GH_TOKEN','GITHUB_TOKEN','DEEPSEEK_API_KEY','OPENAI_API_KEY'):
        if len(os.environ.get(name,''))>=12:values.append(os.environ[name].encode())
    return list(set(values))


def scan(label, content, own, known, identifiers, findings):
    for secret in known:
        if secret in content:findings.append({'file':label,'rule':'known_local_secret','count':content.count(secret)})
    for name,value in identifiers:
        if value and value in content:findings.append({'file':label,'rule':name,'count':content.count(value)})
    for rule,pattern in RULES.items():
        matches=list(re.finditer(pattern,content))
        if matches:findings.append({'file':label,'rule':rule,'count':len(matches),
                                   'lines':[content.count(b'\n',0,m.start())+1 for m in matches[:10]]})
    if own:
        matches=list(ASSIGNMENT.finditer(content))
        if matches:findings.append({'file':label,'rule':'literal_credential_assignment_review','count':len(matches),
                                   'lines':[content.count(b'\n',0,m.start())+1 for m in matches[:10]]})


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--xpi',default='dist/paperbridge-0.4.2-macos-arm64.xpi')
    parser.add_argument('--report',default='.runtime/publication-0.4.2/sensitive-audit.json')
    parser.add_argument('documents',nargs='*',default=['.runtime/publication-0.4.2/README.github-updated.md','.runtime/publication-0.4.2/release-notes.md'])
    args=parser.parse_args();known=known_secrets();findings=[]
    email=subprocess.run(['git','config','--get','user.email'],capture_output=True,text=True).stdout.strip()
    identifiers=[('local_home_path',str(Path.home()).encode()),('local_project_path',str(ROOT).encode())]
    if email and not email.endswith('@users.noreply.github.com'):identifiers.append(('configured_personal_email',email.encode()))
    entries=0;decompressed=0;own_files=0
    xpi=ROOT/args.xpi
    with zipfile.ZipFile(xpi) as archive:
        names=archive.namelist()
        if len(names)!=len(set(names)):findings.append({'file':args.xpi,'rule':'duplicate_archive_members'})
        for info in archive.infolist():
            if info.is_dir():continue
            name=info.filename;parts=Path(name).parts;entries+=1
            if name.startswith('/') or '..' in parts:findings.append({'file':name,'rule':'unsafe_archive_path'})
            if set(parts)&EXCLUDED_PARTS or Path(name).name in EXCLUDED_FILES or name.lower().endswith(('.sqlite','.sqlite3','.db','.pdf','.log','.pem.key','.p12','.pfx')):
                findings.append({'file':name,'rule':'user_data_or_development_artifact'})
            data=archive.read(info);decompressed+=len(data)
            own=not name.startswith('runtime/') or name.startswith('runtime/macos-arm64/backend/')
            own_files+=int(own);scan(name,data,own,known,identifiers,findings)
    for name in args.documents:
        scan(name,(ROOT/name).read_bytes(),True,known,identifiers,findings)
    report={'version':'0.4.2','scope':{'xpi':args.xpi,'documents':args.documents},'archive_members_scanned':entries,
            'archive_uncompressed_bytes_scanned':decompressed,'first_party_files_scanned':own_files,
            'local_known_secret_values_checked':len(known),'secret_values_logged':False,
            'sha256':hashlib.sha256(xpi.read_bytes()).hexdigest(),'findings':findings,
            'status':'passed' if not findings else 'review_required'}
    out=ROOT/args.report;out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
