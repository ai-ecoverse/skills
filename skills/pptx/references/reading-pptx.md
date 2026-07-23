# Reading an existing .pptx

Extract all slide text. The script prints one line per slide plus a total slide count, which
doubles as a validation check for files you just generated:

```bash
cat > /tmp/read_pptx.py << 'EOF'
import zipfile, io, re, sys
data = open(sys.argv[1], 'rb').read()
zf = zipfile.ZipFile(io.BytesIO(data))
slides = sorted(
    [n for n in zf.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
    key=lambda x: int(re.search(r'\d+', x).group())
)
for i, path in enumerate(slides, 1):
    xml = zf.read(path).decode('utf-8', errors='replace')
    texts = re.findall(r'<a:t[^>]*>([^<]+)</a:t>', xml)
    print(f'Slide {i}: {" | ".join(t.strip() for t in texts if t.strip())}')
print(f'Total: {len(slides)} slides')
EOF
python3 /tmp/read_pptx.py /mnt/file.pptx
```

If `zipfile.ZipFile` raises `BadZipFile`, the input is not a valid PPTX (or was corrupted on
write) — regenerate it rather than trying to repair the archive.
