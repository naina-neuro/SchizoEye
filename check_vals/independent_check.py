"""Read-only audit; independent Python calculation, outputs confined to this directory."""
from pathlib import Path
import json, math, statistics as st, hashlib, csv, zipfile, re
W=Path(__file__).resolve().parent; ROOT=W.parent
R=json.loads((W/'verification_results.json').read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
inventory=[]
for p in ROOT.rglob('*'):
    if not p.is_file() or any(x in p.parts for x in ['.git','node_modules','submission_audit_2026-11-06','.venv','venv']):continue
    if p.name.startswith('.env'): continue
    inventory.append({'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p)})
(W/'original_file_inventory.json').write_text(json.dumps(inventory,indent=2))
def runs(flags):
    out=[]; i=0
    while i<len(flags):
        j=i
        while j+1<len(flags) and flags[j+1]==flags[i]:j+=1
        out.append((flags[i],i,j)); i=j+1
    return out
def detect(rows):
    n=len(rows)
    if n<5:return [],[]
    velocities=[[],[]]
    for i in range(n):
        a=max(0,i-2);b=min(n-1,i+2);dt=rows[b][0]-rows[a][0]
        for axis in [1,2]:velocities[axis-1].append((rows[b][axis]-rows[a][axis])/dt if dt>1e-6 else 0)
    eta=[]
    for v in velocities:
        med=st.median(v); sigma=math.sqrt(st.median([(x-med)**2 for x in v]));eta.append(min(25,max(3,3*sigma)))
    flags=[(velocities[0][i]/eta[0])**2+(velocities[1][i]/eta[1])**2>1 for i in range(n)]
    meddt=st.median([(rows[i][0]-rows[i-1][0])*1000 for i in range(1,n)]) or 33
    min_n=max(2,math.floor(20/meddt+.5))
    corrected=flags.copy()
    for f,i,j in runs(flags):
        amp=math.hypot(rows[j][1]-rows[i][1],rows[j][2]-rows[i][2])
        if f and (j-i+1<min_n or amp<.3): corrected[i:j+1]=[False]*(j-i+1)
    fix=[]; sac=[]
    for f,i,j in runs(corrected):
        if not f:fix.append((i,j));continue
        sac.append({'onset':rows[i][0]*1000,'end':rows[j][0]*1000,'amp':math.hypot(rows[j][1]-rows[i][1],rows[j][2]-rows[i][2])})
    return fix,sac
def template(hz,angle=0,duration=None,profile='linear',ramp=1):
    m=max(1,math.floor(hz*duration/1000+.5)) if duration is not None else ramp
    dx=8*math.cos(math.radians(angle)); dy=8*math.sin(math.radians(angle));rows=[]; refs=[]
    def append(q):rows.append((len(rows)/hz,q*dx,q*dy))
    for f in range(15):
        q=f%2
        for k in range(hz//2):append(q)
        if f<14:
            first=len(rows)
            for k in range(1,m+1):
                u=k/m
                prog={'linear':u,'accelerating':u*u,'decelerating':2*u-u*u,'smoothstep':3*u*u-2*u*u*u}[profile]
                append(q+(1-2*q)*prog)
            refs.append((rows[first][0]*1000,rows[-1][0]*1000))
    return rows,refs
def rng(seed):
    s=seed
    while True:
        s=(1664525*s+1013904223)%2**32;yield (s+.5)/2**32
def perturb(rows,kind,level,seed):
    g=rng(seed)
    if kind=='deletion':return [r for r in rows if next(g)>=level]
    def norm():return math.sqrt(-2*math.log(next(g)))*math.cos(2*math.pi*next(g))
    return [(t,x+level/37*norm(),y+level/37*norm()) for t,x,y in rows]
def stats(v):return {'mean':st.mean(v),'sd':st.stdev(v)}
fail=[]; checks=0
def check(name,actual,expected,tol=1e-8):
    global checks
    checks+=1
    if isinstance(actual,(float,int)) and isinstance(expected,(float,int)):
        okay=abs(actual-expected)<=tol
    else:okay=actual==expected
    if not okay:fail.append({'check':name,'actual':actual,'expected':expected})
for i,c in enumerate(R['deterministic']):
    rows,refs=template(c['hz'],ramp=c['ramp']);fs,ss=detect(rows)
    for key,v in [('n',len(rows)),('fixations',len(fs)),('saccades',len(ss)),('meanAmplitude',st.mean(s['amp'] for s in ss)),('firstOnset',ss[0]['onset'])]:check(f'baseline[{i}].{key}',v,c[key])
groups={}
for i,c in enumerate(R['expandedDeterministic']):
    rows,refs=template(c['hz'],c['angleDeg'],c['requestedDurationMs'],c['profile']);fs,ss=detect(rows)
    check(f'extended[{i}].fix',len(fs),c['fixations']);check(f'extended[{i}].sac',len(ss),c['saccades'])
    for j,(s,e) in enumerate(zip(ss,c['events'])):
        check(f'extended[{i}].event[{j}].onset',s['onset'],e['detectedOnsetMs'])
        check(f'extended[{i}].event[{j}].amplitude',s['amp'],e['amplitudeDegDetected'])
        check(f'extended[{i}].event[{j}].reference',refs[j][0],e['firstDisplacedMs'])
        pad=2000/c['hz'];eligible=[k for k,(a,b) in enumerate(refs) if s['end']>=a-pad-1e-8 and s['onset']<=b+pad+1e-8]
        check(f'extended[{i}].event[{j}].unique',eligible,[j])
    group=groups.setdefault((c['hz'],c['profile']),[])
    group.extend((s['onset']-refs[j][0],s['amp']-8) for j,s in enumerate(ss))
perturb_checks=[]
for i,c in enumerate(R['perturbations']):
    fn=[];sn=[];ret=[]
    for rep in range(20):
        rows,_=template(60);rows=perturb(rows,c['kind'],c['level'],1000+rep);fs,ss=detect(rows)
        fn.append(len(fs));sn.append(len(ss));ret.append(len(rows))
    check(f'perturb[{i}].counts',fn,c['counts'])
    for metric,values in [('fixations',fn),('saccades',sn),('retained',ret)]:
        for stat,val in stats(values).items():check(f'perturb[{i}].{metric}.{stat}',val,c[metric][stat])
    perturb_checks.append({'kind':c['kind'],'level':c['level'],'fixations':stats(fn),'saccades':stats(sn),'retained':stats(ret)})
for i,c in enumerate(R['expandedPerturbations']):
    for j,record in enumerate(c['runs']):
        rows,_=template(60,c['angleDeg'],150,c['profile']);rows=perturb(rows,c['kind'],c['level'],record['seed']);fs,ss=detect(rows)
        for key,value in [('retained',len(rows)),('fixations',len(fs)),('saccades',len(ss))]:check(f'expandedPerturb[{i}].run[{j}].{key}',value,record[key])
    for key in ['retained','fixations','saccades']:
        for stat,val in stats([r[key] for r in c['runs']]).items():check(f'expandedPerturb[{i}].{key}.{stat}',val,c[key][stat])
rmse=[]
for c in R['pursuit']:
    g=c['referenceGain'];val=math.sqrt(sum(((g-1)*8*math.sin(2*math.pi*.4*i/60))**2 for i in range(1201))/1201)
    check(f'pursuit gain {g} RMSE',val,c['pipeline']['HS4_Mean_H_RMSE']);rmse.append({'gain':g,'independentRmse':val,'directGainError':abs(c['directGain']-g),'pipelineGainError':abs(c['pipeline']['HS4_Mean_H_gain']-g)})
old=json.loads((ROOT/'revision_work'/'verification_results.json').read_text())
check('fresh results equal saved results',R,old)
csvp=ROOT/'Models'/'synthetic_eye_tracking_3class_59features_RESCALED.csv'
with csvp.open(newline='') as f:reader=csv.DictReader(f);fieldnames=reader.fieldnames;data=list(reader)
from collections import Counter
dataset={'rows':len(data),'columns':len(fieldnames),'features':[n for n in fieldnames if n not in ['subject_id','label']],'labels':dict(Counter(r['label'] for r in data)),'missing_cells':sum(v=='' for r in data for v in r.values()),'duplicate_subject_ids':len(data)-len({r['subject_id'] for r in data}),'sha256':sha(csvp)}
dataset['feature_order_matches']=dataset['features']==R['features']
notebooks=[]
for p in (ROOT/'Models').rglob('*.ipynb'):
    nb=json.loads(p.read_text(encoding='utf-8')); saved=[]
    for i,c in enumerate(nb.get('cells',[])):
        for o in c.get('outputs',[]):
            text=''.join(o.get('text',[])) or ''.join(o.get('data',{}).get('text/plain',[]))
            if text:saved.append({'cell':i,'text':text})
    notebooks.append({'path':str(p.relative_to(ROOT)),'cells':len(nb.get('cells',[])),'saved_outputs':saved})
(W/'notebook_output_inventory.json').write_text(json.dumps(notebooks,indent=2))
doc=ROOT/'Third_draft.docx'
with zipfile.ZipFile(doc) as z:
    xml=z.read('word/document.xml').decode();rels=z.read('word/_rels/document.xml.rels').decode()
    media=[{'path':n,'bytes':len(z.read(n))} for n in z.namelist() if n.startswith('word/media/')]
    docmeta={'sha256':sha(doc),'tracked_insertions':len(re.findall(r'<w:ins\b',xml)),'tracked_deletions':len(re.findall(r'<w:del\b',xml)),'comments_parts':[n for n in z.namelist() if 'comment' in n.lower()],'drawings':xml.count('<w:drawing>'),'media':media,'relationships':rels}
    for n in z.namelist():
        if n.startswith('word/media/'):(W/Path(n).name).write_bytes(z.read(n))
out={'independent_assertions':checks,'failures':fail,'dataset':dataset,'pursuit':rmse,'deterministic_groups':[{'hz':k[0],'profile':k[1],'n':len(v),'onset_min':min(a for a,b in v),'onset_max':max(a for a,b in v),'max_abs_amplitude_error':max(abs(b) for a,b in v)} for k,v in groups.items()],'baseline_perturbations':perturb_checks,'docx':docmeta,'scope':'Independent Python implementation of published detector equations and generators; no browser, camera, database, training or inference executed.'}
(W/'independent_verification.json').write_text(json.dumps(out,indent=2))
print(json.dumps({k:out[k] for k in ['independent_assertions','failures','dataset','pursuit']},indent=2))
