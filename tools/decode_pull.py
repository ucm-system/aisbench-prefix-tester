"""Decode a base64-wrapped ssh_execute stdout payload into an extracted tar.gz."""
import base64
import os
import re
import sys

raw = open(sys.argv[1], encoding="utf-8", errors="ignore").read()
m = re.search(r'"stdout": "(.*)"\s*,\s*\n\s*"stderr"', raw, re.S)
b64 = m.group(1) if m else raw
b64 = b64.replace("\\n", "").replace("\\", "").replace(" ", "")
pad = b64 + "=" * (-len(b64) % 4)
data = base64.b64decode(pad)
open(sys.argv[2], "wb").write(data)
dest = sys.argv[3]
os.makedirs(dest, exist_ok=True)
import tarfile

t = tarfile.open(sys.argv[2])
t.extractall(dest)
t.close()
print(sorted(os.listdir(dest)))
