from pathlib import Path
from lxml import etree
from docx import Document
import json,zipfile,hashlib,re
W=Path(__file__).resolve().parent;ROOT=W.parent
S=json.loads((W/'source_inspection.json').read_text(encoding='utf-8'));changes=json.loads((W/'implemented_changes.json').read_text(encoding='utf-8'))
SRC=ROOT/'Third_draft.docx';OUT=ROOT/'Fourth_draft.docx'
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','m':'http://schemas.openxmlformats.org/officeDocument/2006/math'}
def sha(b):return hashlib.sha256(b).hexdigest()
def parse(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        parts={n:z.read(n) for n in z.namelist()}
    return parts,etree.fromstring(parts['word/document.xml'])
sp,sx=parse(SRC);fp,fx=parse(OUT);d=Document(OUT)
assert set(sp)==set(fp)
part_changes=[n for n in sp if sp[n]!=fp[n]]
assert part_changes==['word/document.xml'],part_changes
old=S['paragraphs'];new=[p.text for p in d.paragraphs]
edited={c['old_paragraph'] for c in changes if 'old_paragraph' in c and not c.get('inserted')}
assert len(new)==len(old)+2
for i,t in enumerate(old):
    ni=i+(2 if i>32 else 0)
    if i not in edited:assert new[ni]==t,(i,t,new[ni])
    else:assert new[ni]==next(c['new_text'] for c in changes if c.get('old_paragraph')==i and not c.get('inserted'))
assert new[33]==changes[1]['new_text'] and new[34]==changes[2]['new_text']
ot=S['tables'];nt=[[[c.text for c in r.cells] for r in t.rows] for t in d.tables]
assert len(nt)==11
cell_diffs=[];unchanged_cells=0
for ti,(a,b) in enumerate(zip(ot,nt)):
    assert len(a)==len(b)
    for ri,(ra,rb) in enumerate(zip(a,b)):
        assert len(ra)==len(rb)
        for ci,(ca,cb) in enumerate(zip(ra,rb)):
            if ca!=cb:cell_diffs.append({'table_index':ti,'row':ri,'column':ci,'old':ca,'new':cb})
            else:unchanged_cells+=1
assert len(cell_diffs)==1 and (cell_diffs[0]['table_index'],cell_diffs[0]['row'],cell_diffs[0]['column'])==(9,3,1)
for ti in [1,2,3,4,5,10]:assert ot[ti]==nt[ti]
old_body=sx.find('w:body',ns);new_body=fx.find('w:body',ns)
old_heads=[p.text for p in Document(SRC).paragraphs if p.style.name.startswith('Heading')]
assert old_heads==[p.text for p in d.paragraphs if p.style.name.startswith('Heading')]
assert etree.tostring(old_body.find('w:sectPr',ns))==etree.tostring(new_body.find('w:sectPr',ns))
assert [etree.tostring(e) for e in sx.xpath('//w:drawing',namespaces=ns)]==[etree.tostring(e) for e in fx.xpath('//w:drawing',namespaces=ns)]
for i in [1,2,3,4,5,6,7]:assert old[i]==new[i]
oldrefs=old[140:148];newrefs=new[142:150]
assert newrefs[1]==oldrefs[1].replace('3839–3844','3839–3845')
assert all(a==b for i,(a,b) in enumerate(zip(oldrefs,newrefs)) if i!=1)
cit=lambda p:re.findall(r'\[(?:\d+)(?:[,–-]\d+)*\]',p)
assert cit(' '.join(old[:139]))==cit(' '.join(new[:141]))
joined='\n'.join(new)+'\n'+'\n'.join(c for table in nt for row in table for c in row)
for forbidden in ['[Confirm','[Insert','[Public supplementary','to be supplied by the authors','3839–3844','This research received no external funding.','Pursuit and fixation means are event-weighted','Correct initial response onset','0.9911','0.9567','0.9679']:
    assert forbidden not in joined,forbidden
assert 'prepared for submission' in joined and 'Delivery of the archive with the submission is pending' in joined
assert '258c59fee71c6f236edf1c2610436291b63cd9da861801bfd9b730f8602bb498' in joined
assert 'contributed equally' in joined and 'No specific funding was received for this work.' in joined
assert '3–6 November 2026' in joined
assert 'For t[b] − t[a] > 10⁻⁶ s' in joined
assert all(s in joined for s in ['0.035','0.12','max(0.3, quality)','floor(n/2)','0.8 of the initial','60 samples overall','less than 250 ms old'])
# Every originally unedited paragraph's numbers remain exactly preserved through
# the text comparison above, including Abstract, all Results, Discussion and Conclusions.
protected_changed=[]
for entry in S['protected_files']:
    path=ROOT/entry['path']
    if not path.exists() or sha(path.read_bytes())!=entry['sha256']:protected_changed.append(entry['path'])
assert not protected_changed,protected_changed
tables=fx.xpath('/w:document/w:body/w:tbl',namespaces=ns)
assert all(t.xpath('./w:tr[1]/w:trPr/w:tblHeader',namespaces=ns) for t in tables)
assert all(row.xpath('./w:trPr/w:cantSplit',namespaces=ns) for t in tables for row in t.findall('w:tr',ns))
assert not fx.xpath('//w:ins|//w:del',namespaces=ns)
assert not any('comments' in k.lower() for k in fp)
result={
    'source_docx_sha256':sha(SRC.read_bytes()),'fourth_docx_sha256':sha(OUT.read_bytes()),
    'source_paragraphs':len(old),'fourth_paragraphs':len(new),'unchanged_original_paragraphs':len(old)-len(edited),'modified_original_paragraphs':sorted(edited),'inserted_calibration_paragraphs':2,
    'editable_tables':len(nt),'unchanged_table_cells':unchanged_cells,'changed_table_cells':cell_diffs,'research_result_tables_exactly_preserved':['2','3','4','5','6','B1'],
    'abstract_words':len(new[9].split()),'all_headings_preserved':True,'all_citation_sequences_preserved':True,'references_preserved_except_corrected_pagination':True,'author_metadata_preserved':True,
    'figure_drawing_and_all_media_bytes_preserved':True,'section_and_page_geometry_preserved':True,'changed_package_parts':part_changes,'all_other_package_parts_preserved':len(fp)-1,
    'protected_original_files_checked':len(S['protected_files']),'protected_original_files_changed':protected_changed,'all_table_headers_repeat':True,'all_table_rows_indivisible':True,
    'zip_integrity_and_docx_reopen_passed':True,'internal_placeholders_removed':True,'substantive_scope_preserved':True,'new_experiments_executed':False,'clinical_metrics_introduced':False}
(W/'structural_verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
# Full extraction for editorial rereading, including all tables in order.
blocks=[]
from docx.table import Table
from docx.text.paragraph import Paragraph
for child in d.element.body:
    if child.tag.endswith('}p'):
        p=Paragraph(child,d);blocks.append(p.text)
    elif child.tag.endswith('}tbl'):
        table=Table(child,d);blocks.extend(' | '.join(c.text for c in row.cells) for row in table.rows)
(W/'Fourth_draft_full_text.txt').write_text('\n'.join(blocks),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
