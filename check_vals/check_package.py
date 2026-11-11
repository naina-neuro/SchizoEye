from pathlib import Path
import zipfile,json,hashlib,re
from PIL import Image,ImageOps,ImageDraw
W=Path(__file__).resolve().parent;ROOT=W.parent
zpath=ROOT/'revision_work'/'review_round_2'/'verification_archive_2026-11-05.zip'
dest=W/'archive_reproduction';dest.mkdir(exist_ok=True)
with zipfile.ZipFile(zpath) as z:
    for info in z.infolist():
        target=(dest/info.filename).resolve()
        assert target.is_relative_to(dest.resolve()),info.filename
        z.extract(info,dest)
    names=z.namelist()
source=(ROOT/'frontend'/'battery-controller.js').read_text(encoding='utf-8')
raw=source[source.index('const FEATURE_ORDER ='):source.index('  function buildFvRows()')]
portable=next(dest.rglob('pipeline_numerics.js')).read_text(encoding='utf-8')
import difflib
diff=list(difflib.unified_diff(raw.splitlines(),portable.splitlines()))
print(json.dumps({'archive_sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'members':names,'snapshot_diff':diff},indent=2))
(W/'archive_inspection.json').write_text(json.dumps({'archive_sha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'members':names,'snapshot_diff':diff},indent=2))
pages=list(W.glob('source_page-*.png'))
if pages:
    for start in range(0,len(pages),5):
        sheet=Image.new('RGB',(2500,740),'#dddddd')
        for j,p in enumerate(pages[start:start+5]):
            im=Image.open(p).convert('RGB');im.thumbnail((490,700));sheet.paste(im,(j*500,25));ImageDraw.Draw(sheet).text((j*500+10,5),p.stem,fill='black')
        sheet.save(W/f'contact_{start//5+1}.png')
