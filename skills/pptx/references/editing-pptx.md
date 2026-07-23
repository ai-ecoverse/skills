# Editing an existing .pptx

> **Important**: edit operations manipulate ZIP/XML internals directly. Always verify the output by
> reading it back (slide count, key text) before delivering it. If the output looks malformed,
> re-run the read operation (see [`reading-pptx.md`](reading-pptx.md)) against the output file to
> confirm integrity.

## Replace text

```bash
cat > /tmp/edit_pptx.py << 'EOF'
import zipfile, io, sys
src, dst, find, replace = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = open(src, 'rb').read()
src_zip = zipfile.ZipFile(io.BytesIO(data))
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
    for name in src_zip.namelist():
        content = src_zip.read(name)
        if name.startswith('ppt/slides/slide') and name.endswith('.xml'):
            content = content.replace(find.encode(), replace.encode())
        out.writestr(name, content)
open(dst, 'wb').write(buf.getvalue())
print(f'Saved: {dst}')
EOF
python3 /tmp/edit_pptx.py /mnt/input.pptx /mnt/output.pptx "Old Title" "New Title"
open --download /mnt/output.pptx
```

**Verify after replace**: run the read script against `/mnt/output.pptx` to confirm the
replacement took effect and the file is still readable.

## Add a text slide

```bash
cat > /tmp/add_slide.py << 'EOF'
import zipfile, io, re, sys
src, dst = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else 'New Slide'
body = sys.argv[4] if len(sys.argv) > 4 else ''
data = open(src, 'rb').read()
src_zip = zipfile.ZipFile(io.BytesIO(data))
slides = [n for n in src_zip.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)]
new_num = len(slides) + 1
new_slide_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClr/></p:clrMapOvr>
</p:sld>'''
new_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
prs_xml = src_zip.read('ppt/presentation.xml').decode('utf-8')
max_id = max((int(x) for x in re.findall(r'id="(\d+)"', prs_xml)), default=256)
prs_xml = prs_xml.replace('</p:sldIdLst>', f'<p:sldId id="{max_id+1}" r:id="rId{new_num+10}"/></p:sldIdLst>')
prs_rels = src_zip.read('ppt/_rels/presentation.xml.rels').decode('utf-8')
prs_rels = prs_rels.replace('</Relationships>', f'<Relationship Id="rId{new_num+10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{new_num}.xml"/></Relationships>')
ct = src_zip.read('[Content_Types].xml').decode('utf-8')
ct = ct.replace('</Types>', f'<Override PartName="/ppt/slides/slide{new_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
    for name in src_zip.namelist():
        if name == 'ppt/presentation.xml': out.writestr(name, prs_xml.encode())
        elif name == 'ppt/_rels/presentation.xml.rels': out.writestr(name, prs_rels.encode())
        elif name == '[Content_Types].xml': out.writestr(name, ct.encode())
        else: out.writestr(name, src_zip.read(name))
    out.writestr(f'ppt/slides/slide{new_num}.xml', new_slide_xml.encode())
    out.writestr(f'ppt/slides/_rels/slide{new_num}.xml.rels', new_rels.encode())
open(dst, 'wb').write(buf.getvalue())
print(f'Added slide {new_num}: "{title}" -> {dst}')
EOF
python3 /tmp/add_slide.py /mnt/input.pptx /mnt/output.pptx "Slide Title" "Body text"
open --download /mnt/output.pptx
```

**Verify after adding a slide**: run the read script against `/mnt/output.pptx` and confirm the
slide count increased by one and the new slide title appears in the output.
