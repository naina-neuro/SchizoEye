from pathlib import Path
from collections import defaultdict
import json, math
W=Path(__file__).resolve().parent
R=json.loads((W.parent/'verification_results.json').read_text())
G=defaultdict(list)
for c in R['expandedDeterministic']:
    for e in c['events']:G[c['hz'],c['profile']].append(e)
groups=[]
for (hz,profile),es in G.items():
    vals=[e['onsetErrorMs'] for e in es if e['status']=='matched']
    amps=[e['amplitudeErrorDeg'] for e in es if e['status']=='matched']
    groups.append(dict(hz=hz,profile=profile,n=len(es),onset_min=min(vals),onset_max=max(vals),amplitude_min=min(amps),amplitude_max=max(amps)))
P=defaultdict(list)
for c in R['expandedPerturbations']:P[c['kind'],c['level']].append(c)
pert=[]
for (kind,level),cs in P.items():
    runs=[r for c in cs for r in c['runs']]
    pert.append(dict(kind=kind,level=level,conditions=len(cs),runs=len(runs),fix_mean_range=[min(c['fixations']['mean'] for c in cs),max(c['fixations']['mean'] for c in cs)],sac_mean_range=[min(c['saccades']['mean'] for c in cs),max(c['saccades']['mean'] for c in cs)],fix_raw_range=[min(r['fixations'] for r in runs),max(r['fixations'] for r in runs)],sac_raw_range=[min(r['saccades'] for r in runs),max(r['saccades'] for r in runs)],runs_15fix=sum(r['fixations']==15 for r in runs),runs_14sac=sum(r['saccades']==14 for r in runs)))
fail=[]
for c in R['expandedPerturbations']:
    if c['kind']=='deletion' and any(r['fixations']!=15 or r['saccades']!=14 for r in c['runs']):fail.append({k:c[k] for k in ['angleDeg','profile','level','fixations','saccades']})
out={'deterministic_groups':groups,'perturbation_groups':pert,'deletion_nonreference_conditions':fail}
(W/'extension_recomputed.json').write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
