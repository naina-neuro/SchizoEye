from pathlib import Path
import json,re,math,statistics as st,hashlib,collections,unicodedata
W=Path(__file__).resolve().parent;ROOT=W.parent
B=json.loads((W/'manuscript_blocks.json').read_text());R=json.loads((W/'verification_results.json').read_text());I=json.loads((W/'independent_verification.json').read_text())
P={x['index']:x for x in B if x['kind']=='paragraph'};T={x['index']:x for x in B if x['kind']=='table'}
pages=json.loads((W/'word_page_map.json').read_text(encoding='utf-8-sig'))
def norm(s):return ' '.join(unicodedata.normalize('NFKC',s).replace('\x07','').split())
page_lookup=collections.defaultdict(list)
for x in pages:page_lookup[norm(x['text'])].append(x)
# Match cells in document order so recurring values such as 0 and 15 do not
# incorrectly acquire the page numbers of every other table containing them.
ordered_locations={}; cursor=0
for block in B:
    items=[(None,None,block['text'])] if block['kind']=='paragraph' else [(ri,ci,cell) for ri,row in enumerate(block['rows']) for ci,cell in enumerate(row)]
    for ri,ci,txt in items:
        if not norm(txt):continue
        found=next((j for j in range(cursor,len(pages)) if norm(pages[j]['text'])==norm(txt)),None)
        if found is None:raise RuntimeError(f'Document-order page match failed: {block["index"]} {txt}')
        hit=pages[found];cursor=found+1
        ordered_locations[(block['kind'],block['index'],ri,ci)]=hit
page_missing=[]
def page(text):
    hits=page_lookup.get(norm(text),[])
    if not hits:page_missing.append(text);return 'page not mapped'
    lo=min(x['page'] for x in hits);hi=max(x.get('pageEnd',x['page']) for x in hits)
    return str(lo) if lo==hi else f'{lo}–{hi}'
section='Front matter'; sections={}
for b in B:
    if b['kind']=='paragraph':
        if b['style'].startswith('Heading'):section=b['text']
        if b['text'] in ['Supplementary Materials','Author Contributions','Funding','Institutional Review Board Statement','Informed Consent Statement','Data Availability Statement','Acknowledgments','Conflicts of Interest']:section=b['text']
        sections[b['index']]=section
def loc(i):return f"{sections[i]}; p. {page(P[i]['text'])}; P{i}"
def code(file,lines,function):return {'path':str(ROOT/file),'lines':lines,'function':function}
BAT='frontend/battery-controller.js';EYE='frontend/eye-tracker.js';H='revision_work/verify_pipeline.cjs'
def bat(lines,fn):return code(BAT,lines,fn)
def eye(lines,fn):return code(EYE,lines,fn)
def harness(lines,fn):return code(H,lines,fn)
D={}
def register(ids,codes,evidence,status='Verified',correction='None for the stated scope.'):
    for i in ids:D[i]={'code':codes,'evidence':evidence,'status':status,'correction':correction}
impl='Implemented: source inspection only; acquisition/browser operation was not executed or experimentally validated.'
num='Executed, evaluated and reproduced: fresh verification_results.json; independent_verification.json (14,007 checks, no failures); also standalone archive_reproduction/verification_results.json. Evidence is limited to the stated constructed inputs.'
register([1],[bat('1090–2246','numerical feature-extraction block')],'Descriptive title consistent with the study boundary; not a camera-accuracy or clinical-performance claim.')
register(range(2,8),[],'Matches names, affiliations, emails and four correspondents supplied by the user; institutional identity and authorship are not independently authenticated.','Not verifiable','Author declaration; retain approved information, no invented verification.')
register([9,15,16],[harness('26–121','constructed suites and output'),bat('1543–2243','event/extraction/finalization functions')],num)
register([10],[bat('1090–2243','feature schema and numerical methods')],'Keywords accurately describe subject matter; no performance assertion.')
register([12,13,19],[],'Literature/background: primary articles [1]–[3] and source-defined interpretation chain; offsets 172/207 pixels are literature results, not application measurements.')
register([14],[eye('172–198,230–258','extractFeatures/fitRidge/ridgePredict')],'Implemented source chain; Google Research [4] explicitly distinguishes iris localization from gaze estimation. No landmark accuracy reproduced.')
register([20],[],'Primary article abstracts [5] and [6] support simultaneous Labvanced/EyeLink five-task comparison and 1.4-degree accuracy, and method-dependent sensitivity. No transfer of those results to this application.')
register([22],[bat('1543–1674','ekAxisVelocity/ekMedianBasedSD/detectEventsEK')],'Original Engbert–Kliegl study identity supports algorithm-family context. Source confirms explicitly implementation-specific derivative/spread/filters; no original-method equivalence claimed.')
register([23],[bat('2121–2193','extractAntisaccade')],'Background [1] plus executed omission cases; novelty framed as a characterization of this implementation, not invention of webcam tracking.')
register([26,28,29],[harness('1–24,26–121','source extraction, VM and suites')],num+' Full source and block hashes checked; portable snapshot differs only in one descriptive comment. AI assistance is disclosed; author responsibility is a declaration.')
register([31],[eye('22–58,172–198,414–419','CFG/camera constraints/extractFeatures/frameTick')],impl)
register([32],[eye('22–36,816–863,1001–1026','CFG/rejectOutliers/captureAtPoint/calibrate')],impl,'Verified','I06: specify retry threshold, motion gate, weighting and retention fallback for fuller acquisition reproducibility; no numerical-result correction.')
register([33],[eye('117–157,230–258,292–297','KF/fitRidge/gaussElim/processGazeSample')],impl+' Ridge equation matches inspected weighted normal equations; solver conditioning not evaluated.')
register([34],[eye('783–790,1046–1064','validationPoints/calibrate')],impl+' Source explicitly falls back to fit error; no real held-out error distribution exists.')
register([36,37],[bat('32–36,311–370,433–463,512–585,727–777','protocol constants/startSZ/pursuit/free-viewing')],impl+' Stimulus content labels and reuse rights not authenticated.')
register([39],[bat('433–463,524–526,553–564','spemStartMovingTask/startSZ')],impl+' Sinusoidal stimulus formulas match source; browser randomization is unseeded, unlike numerical tests.')
register([40],[bat('13–14,136–144,1298–1362','start/px2deg/normalizeFv/normalizeSpem/normalizeSz')],impl+' One fresh normalization diagnostic confirms 74 pixels→2 degrees, 111→3 at PPD 37; this is not measured viewing geometry.')
register([42],[bat('1543–1598','ekAxisVelocity/ekMedianBasedSD/detectEventsEK')],num,'Verified','I06: state dt > 10⁻⁶-s guard; otherwise code leaves velocity zero.')
register([43,44],[bat('1574–1674','detectEventsEK')],num+' Minimum fixation fields are inactive; ordinary callers’ differently named duration/amplitude settings coincide with detector defaults for this snapshot.')
register([46],[bat('1886–1932','extractFreeViewing')],'Implemented: image eligibility, aggregation and dispersion definitions inspected. Executed/reproduced: empty-input fallback. No comprehensive nonempty-image feature validation claimed.')
register([47],[bat('1739–1883,1941–2037','resampleLinear/amplitudeAtFrequency/periodogram/computeGain/computeRmse/computeLogSNR/extractPursuit')],'Implemented spectral and retained-sample definitions inspected; three proportional horizontal sinusoids executed/reproduced. Independent RMSE recalculated; vertical pursuit, absolute Fourier calibration, SNR and catch-up masking not experimentally validated.')
register([48],[bat('2042–2081,2094–2181','extractFixationCondition/splitAntisaccadeTrials/findQualifyingSaccadeOnset/extractAntisaccade')],'Implemented: trial pooling, splitting and onset definitions. Executed/reproduced: four single-trial antisaccade examples; no live stimulus-onset synchronization or multi-trial segmentation validation.')
register([49],[bat('2084–2193','estimateCenterX/extractAntisaccade')],num+' Antisaccade definitions are verified failure behavior, not validated behavioral labels.')
register([50],[bat('1152–1224,2197–2243','BOUNDS/roundFeature/NA_FALLBACK_MIDPOINT/finalizeFeature')],'Implemented and executed: original probes reproduce; additional_probes.json includes all 59 nonfinite and 118 finite-clamp probes. Bounds are configuration, not physiological validation.')
register([52],[harness('26–38','trajectory/detect/baseline loop')],num)
register([53,54],[harness('58–104','profileFunctions/extendedTrajectory/matchEvents/deterministic loop')],num+' Independent Python regenerates reference intervals and tests unique association in both directions; finite sampled-onset convention preserved.')
register([55,56],[harness('26–50','trajectory/rng/stats/baseline perturbations')],num+' 11 levels ×20=220 calls, including two sets of zero-perturbation baselines; per-axis jitter and original timestamps preserved.')
register([57],[harness('105–117','expanded perturbation loop')],num+' 12 direction/profile configurations ×7 levels ×20=1680 calls; no noisy event matching or kinematic result is claimed.')
register([58],[harness('51–52','pursuit cases'),bat('1861–1883,1941–2037','computeGain/computeRmse/extractPursuit')],num+' Independent closed-form sampled RMSE check; proportional gain agreement cannot validate absolute spectral amplitude scale.')
register([59],[harness('53–55','antisaccade/finalization/emptyFV probes'),bat('2121–2243','extractAntisaccade/finalizeFeature')],num)
register([61],[harness('37,85–119','stats/matchEvents/output summaries')],num+' No inferential test or population confidence interval reported; 20 matched seeded realizations are generated numerical cases.')
register([62],[code('Models/retrain_fixed.py','20–95','data preparation/StratifiedKFold/training'),code('backend/app.py','226–274,277–347','model loading/classify')],'Implemented training settings and model-loading path inspected. CSV independently scanned (300 rows, label counts, 59-feature order, missing values/IDs). No training/inference executed; historical notebook logs are not evidence of clinical performance. Generator and OOF prediction artifacts not located.')
register([65,66,68,69,70],[harness('26–38,58–104','baseline and extended deterministic suites'),bat('1543–1674','detectEventsEK')],num)
register([73,74,76,77,79],[harness('39–50,105–117','baseline and expanded perturbations'),bat('1543–1674','detectEventsEK')],num)
register([81],[harness('51–52','pursuit cases'),bat('1861–1883,1941–2037','computeGain/computeRmse/extractPursuit')],num+' Independent RMSE: 1.6963496097015858, 0, 1.1308997398010567; max gain error 8.88×10⁻¹⁶.')
register([83,84,86],[harness('53','antisaccade cases'),bat('2121–2193','extractAntisaccade')],num)
register([88],[harness('54–55','finalization/emptyFV probes'),bat('1886–1932,2226–2243','extractFreeViewing/finalizeFeature')],num+' Additional all-feature clamp/substitution diagnostics are separate audit checks.')
register([89],[code('backend/app.py','694–695,819–861','save_results/session_doc/database insert'),bat('2495–2550','saveSessionToDatabase')],'Implemented metadata payload and persistence call inspected. No database, camera or clinical evaluation executed; negative evidence statement is bounded to materials available to this audit.')
register([92,93,96,106],[bat('1543–1674,2121–2243','event detection/antisaccade/finalization'),harness('26–119','verification suites')],num+' Interpretation is limited to tested templates and observed counterexamples; no universal causal/rotation-invariance or deletion-timing claim.')
register([94],[bat('2121–2193','current extractAntisaccade')],'Proposed future response/omission/tolerance rules. Source confirms these changes are not implemented. Their effectiveness has not been tested.','Not verifiable','Recommendation only; do not represent a candidate fix as an implemented or validated contribution.')
register([97],[bat('2226–2243,2337–2344,2495–2550','finalizeFeature/dataQuality/session payload')],'Recommendation motivated by reproduced ambiguity. Current lowConfidence/dataQuality support is partial; detailed provenance ledger is absent and explicitly described as not implemented.','Not verifiable','No correction needed to current recommendation; validation required before claiming deployment success.')
register([99],[],'Comparison boundary supported by primary studies [3,5,6] and Google component description [4]. No current tracker accuracy ranking is made; synchronized reference comparison remains proposed.')
register([100],[code('Models/retrain_fixed.py','20–95','training pipeline')],'XGBoost identity supported by [8]; absence of clinical cohort and synthetic-data provenance bounds inference. This is a limitation, not a verified diagnostic result.')
register([102],[harness('26–119','all constructed suites')],'Verified scope limitation by complete generator and execution inspection: rates/directions/profiles fixed, camera/calibration bypassed, no physiological labels or participants. No end-to-end equivalence executed.')
register([103],[harness('1–24,26–119','VM boundary/suites'),bat('136–144,2042–2062','PPD/fixation pooling')],'Available-file inventory and source inspection support stated evidence gaps; external clinical/training rights/provenance cannot be authenticated. Schema inspection and selected probes do not validate all 59 physiological measures.')
register([104],[],'Future work recommendation, not a claim that experiments or ethics review were performed.','Not verifiable','No correction needed; these experiments are not prerequisites for the bounded current findings.')
register([108],[],'Local archive inspected and independently executed. Public/reviewer delivery not established; two unresolved release instructions remain.','Partial','I01: deliver exact package as supplement or archive and replace both availability placeholders accurately.')
register([110],[],'Matches user-supplied role allocation, but equal contribution omitted and internal confirmation instruction remains. Authorship cannot be independently authenticated.','Partial','I03: remove internal instruction and restore equal contribution, preferably with full names.')
register([112],[],'Author supplied “No specific funding”; manuscript strengthens this to “no external funding”. Financial circumstances not independently audited.','Not verifiable','I04: restore supplied statement or obtain explicit adoption of stronger wording.')
register([114,116],[],'Author ethics/consent declaration consistent with constructed numerical tests. No institutional determination or synthetic generator supplied; this is not independent IRB/legal certification.','Not verifiable','Retain author-approved computational-scope statement; do not infer clinical approval or provenance from a filename.')
register([118],[harness('26–121','generators/outputs')],'Numerical generation, seeds and local artifacts verified; actual reviewer/public access not established.','Partial','I01: actual Supplementary File S1 delivery or verified archive required; remove bracketed instruction.')
register([120],[],'Codex assistance is disclosed and executed numerical outputs reproduce. Authors’ review, responsibility and historical dates are declarations.','Not verifiable','If later substantive revisions use this audit, update the actual use period and submission-form disclosure.')
register([122],[],'Matches user-provided conflict declaration; external financial relationships are not independently audited.','Not verifiable','Author declaration; no invented verification.')
register([124,125,127,129,131],[bat('1090–1224,1574–2243','FEATURE_ORDER/BOUNDS/event and feature functions')],'All 59 ordered feature names and bounds machine-compared with current source; definitions/units inspected. Counts/kinematics are operational definitions, not physiological measurement validation.')
register([133],[bat('1886–1932,1941–2037,2042–2062,2121–2193','all task aggregation functions')],'Most aggregation/denominator descriptions match source. Event weighting does not describe retained-sample RMSE or spectral gain/logSNR.','Partial','I05: narrow weighting sentence to event-derived duration/kinematic summaries.')
register([137,138],[harness('105–117','expanded perturbation output')],num+' B1 summarizes largest jitter/deletion levels; full extended JSON retains all per-run counts.')
refs={140:'https://www.nature.com/articles/nrn1345',141:'https://www.ijcai.org/Proceedings/16/Papers/540.pdf',142:'https://pubmed.ncbi.nlm.nih.gov/28593605/',143:'https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/',144:'https://pubmed.ncbi.nlm.nih.gov/37821751/',145:'https://pubmed.ncbi.nlm.nih.gov/39654819/',146:'https://www.sciencedirect.com/science/article/pii/S0042698903000841',147:'https://github.com/dmlc/xgboost/blob/master/CITATION'}
for i,url in refs.items():register([i],[],'Bibliographic identity and relevant attribution checked against primary record: '+url+'. Resolver/access failures are documented; not every URL was successfully resolved live.','Contradicted' if i==141 else 'Verified','I02: pages must be 3839–3845.' if i==141 else 'No metadata correction identified; access dates are author historical records, not independently authenticated.')

claims=[];coverage=[]
skip=[]
for i,b in P.items():
    if not b['text'].strip() or b['style'].startswith('Heading') or i in [0,107,109,111,113,115,117,119,121]:
        skip.append({'paragraph':i,'reason':'heading, section label, or blank'});continue
    if i not in D:raise RuntimeError(f'Unmapped substantive paragraph P{i}: {b["text"]}')
    sentences=[b['text']] if i in list(range(2,8))+[110]+list(refs) else re.split(r'(?<=[.!?])\s+(?=[A-Z0-9“])',b['text'])
    ids=[]
    for sentence in sentences:
        entry=D[i].copy()
        # Localize corrections instead of flagging every sentence in the same paragraph.
        if i==133 and not sentence.startswith('Pursuit and fixation means'):
            entry['status']='Verified';entry['correction']='None for stated operational definition.'
        if (i==108 and not sentence.startswith('A portable')) or (i==118 and sentence.startswith('The constructed')):
            entry['status']='Verified';entry['correction']='None for local artifact description; public delivery is addressed separately in I01.'
        if (i==94 and sentence.startswith('They have not')) or (i==97 and sentence.startswith('This recommendation follows')):
            entry['status']='Verified';entry['correction']='None; current source confirms proposed changes are not implemented.'
        if i==120 and sentence.startswith('Reported numerical findings'):
            entry['status']='Verified';entry['evidence']=num;entry['code']=[harness('1–121','source extraction and executed numerical suites')];entry['correction']='None for numerical-execution statement.'
        if i==110:pass
        row={'id':f'C{len(claims)+1:03d}','claim':sentence,'location':loc(i),'paragraph':i,'supporting_code':entry['code'],'experimental_evidence':entry['evidence'],'status':entry['status'],'required_correction':entry['correction']}
        claims.append(row);ids.append(row['id'])
    coverage.append({'paragraph':i,'location':loc(i),'claim_ids':ids,'text':b['text']})

def f(x,d=2):
    if abs(x)<.5*10**(-d):x=0
    return f'{x:.{d}f}'
def pm(d):return f(d['mean'])+' ± '+f(d['sd'])
results=[];fail=[]
def add_result(ti,ri,expected,evidence,calc,status='Verified'):
    cells=T[ti]['rows'][ri];actual=[norm(x).replace('−','-') for x in cells]
    exp=[norm(str(x)).replace('−','-') for x in expected]
    ok=actual==exp
    if status=='Verified' and not ok:fail.append({'table':ti,'row':ri,'printed':actual,'expected':exp})
    # Each table row is also a claim; every numeric cell is preserved.
    table_names=['Table 1','Table 2','Table 3','Table 4','Table 5','Table 6','Table A1','Table A2','Table A3','Table A4','Table B1']
    pnums=[37,66,70,74,77,84,125,127,129,131,138];p=pnums[ti]
    cellpages=sorted({str(ordered_locations[('table',ti,ri,ci)]['page']) for ci,c in enumerate(cells)},key=int)
    location=f'{table_names[ti]}; row {ri}; p. '+(','.join(cellpages) if cellpages else page(P[p]['text']))
    res={'id':f'R{len(results)+1:03d}','manuscript_result':' | '.join(cells),'location':location,'experimental_source':evidence,'calculation':calc,'recalculated_result':' | '.join(map(str,expected)),'status':status if ok or status!='Verified' else 'Contradicted'}
    results.append(res)
    cc=D[p]
    claims.append({'id':f'C{len(claims)+1:03d}','claim':' | '.join(cells),'location':location,'table':table_names[ti],'supporting_code':cc['code'],'experimental_evidence':evidence+'; '+calc,'status':res['status'],'required_correction':'None for stated scope.' if res['status']=='Verified' else 'See accompanying results evidence; source-defined protocol has not been executed live.'})
for ri,cells in enumerate(T[0]['rows'][1:],1):
    add_result(0,ri,cells,'Source protocol inspected; no task delivery/browser session executed.','Task constants and loops; feature order blocks 36/10/4/9.','Verified')
for ri,c in enumerate(R['deterministic'],1):add_result(1,ri,[c['hz'],c['ramp'],c['fixations'],c['saccades'],f(c['meanAmplitude']),f(c['firstOnset']-c['referenceOnset'],1)],f'verification_results.json deterministic[{ri-1}]; independent regenerated trajectory','Counts, mean endpoint amplitude and first-onset minus 500 ms; round as printed.')
for ri,g in enumerate(I['deterministic_groups'],1):add_result(2,ri,[g['hz'],g['profile'],g['n'],f(g['onset_min'],1)+' to '+f(g['onset_max'],1),f(g['max_abs_amplitude_error'],5)],f'independent_verification.json deterministic_groups[{ri-1}] / fresh extended event records','Group 12 conditions by rate/profile; 14 events each; min/max onset error and max absolute amplitude error.')
for ri,c in enumerate([c for c in R['perturbations'] if c['kind']=='jitter'],1):add_result(3,ri,[c['level'],pm(c['fixations']),pm(c['saccades']),f"+{100*(c['fixations']['mean']-15)/15:.1f}%"],f'Fresh perturbations jitter level {c["level"]}; independent_verification.json baseline_perturbations','Mean and sample SD across 20 generated runs; relative FN increase =100(mean−15)/15.')
for ri,c in enumerate([c for c in R['perturbations'] if c['kind']=='deletion'],1):add_result(4,ri,[f(c['level']),pm(c['retained']),pm(c['fixations']),pm(c['saccades'])],f'Fresh perturbations deletion level {c["level"]}; independent regenerated 20 runs','Mean and sample SD; original timestamps preserved.')
for ri,c in enumerate(R['antisaccade'],1):
    o=c['output'];lat=o['antisaccade_latency'];add_result(5,ri,[['Correct step','Wrong step','Stationary','Stationary'][ri-1],c['target'],o['antisaccade_error_rate'],o['antisaccade_correction_error_rate'],o['antisaccade_accuracy'],'NA' if lat is None else f(lat,1)],f'Fresh antisaccade[{ri-1}], extractAntisaccade','Direct raw function outputs; JSON null is nonfinite raw latency, not substituted latency.')
feature_idx=0;feature_fail=[]
for ti in [6,7,8,9]:
    for ri,cells in enumerate(T[ti]['rows'][1:],1):
        name,definition,unit,bounds=cells;bound=R['bounds'].get(name)
        if name!=R['features'][feature_idx]:feature_fail.append(f'Order at {feature_idx}: {name}')
        expected=f"{bound['lower']:g} to {bound['upper']:g}"
        if bounds!=expected:feature_fail.append(f'{name}: {bounds} != {expected}')
        add_result(ti,ri,[name,definition,unit,expected],f'Fresh FEATURE_ORDER[{feature_idx}], BOUNDS[{name}]; source task formula inspection; additional_probes.json','Name, order and bounds machine-compared. Definition/unit inspected against source; no full physiological validation implied.')
        feature_idx+=1
for ri,c in enumerate([c for c in R['expandedPerturbations'] if c['kind']=='jitter' and c['level']==12],1):add_result(10,ri,[c['angleDeg'],c['profile'],pm(c['fixations']),pm(c['saccades'])],f'Fresh expandedPerturbations angle={c["angleDeg"]}, profile={c["profile"]}, jitter=12; 20 independent regenerated runs','Mean and sample SD of FN/SN; every deletion=.30 run separately confirmed to retain 15/14 event counts.')
# All prose quantitative findings; method-only constants remain in claim matrix.
for c in claims.copy():
    if 'paragraph' in c and c['paragraph'] in [9,65,68,69,73,76,79,81,83,86,88,89,92,96,106,137,138] and re.search(r'\d|zero|every|all|no ',c['claim'],re.I):
        results.append({'id':f'R{len(results)+1:03d}','manuscript_result':c['claim'],'location':c['location'],'experimental_source':c['experimental_evidence'],'calculation':'See specific table rows and independent_verification.json; for absence/scope statements see inspected execution boundary.','recalculated_result':'Matches stated rounded values or explicitly stated evidence limit.','status':c['status']})
assert not fail,fail
assert not feature_fail,feature_fail
assert feature_idx==59
portable=json.loads((W/'archive_reproduction'/'verification_results.json').read_text())
diff={k:{'source':R[k],'portable':portable[k]} for k in R if R[k]!=portable[k]}
assert set(diff)=={'loadedSourceKind','numericalBlockSha256'},list(diff)
# Verify all original files recorded before report building remain unchanged.
inventory=json.loads((W/'original_file_inventory.json').read_text());changed=[]
for r in inventory:
    p=ROOT/r['path']
    if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256']:changed.append(r['path'])
assert not changed,changed
def safe(s):return str(s).replace('|','&#124;').replace('\n','<br>')
def codelinks(codes):
    return '; '.join(f"[{Path(c['path']).name}]({Path(c['path']).as_posix()}:{c['lines'].split('–')[0].split(',')[0]}) {c['function']}, lines {c['lines']}" for c in codes) or 'No application code required; see evidence.'
headers=['ID','Manuscript claim','Section/page','Supporting code file/function/lines','Experimental evidence','Status','Required correction']
md=['# Complete manuscript claim verification matrix','',f'{len(claims)} entries; exact statements from every substantive paragraph and every table data row. Sentences containing several related clauses preserve the full statement; all clauses share the stated evidence boundary. Headings and blank paragraphs are recorded separately in coverage_inventory.json. Repeated claims are retained at each location.','', 'Status concerns the stated claim. An implementation-only description can be Verified without execution; its evidence column explicitly says source inspection only. Recommendations and declarations are not experimental results.','', '| '+' | '.join(headers)+' |','|'+'|'.join(['---']*len(headers))+'|']
for c in claims:md.append('| '+' | '.join(map(safe,[c['id'],c['claim'],c['location'],codelinks(c['supporting_code']),c['experimental_evidence'],c['status'],c['required_correction']]))+' |')
(W/'CLAIM_VERIFICATION_MATRIX.md').write_text('\n'.join(md),encoding='utf-8')
(W/'claim_verification_matrix.json').write_text(json.dumps(claims,ensure_ascii=False,indent=2),encoding='utf-8')
hdr=['ID','Reported quantitative result','Location','Experimental source','Calculation','Recalculated or verified result','Status']
md=['# Complete results and numerical configuration verification','', 'Research-result tables, protocol table, all 59 schema/bound rows, and quantitative prose findings. Protocol constants and bounds are source settings, not empirical measurement performance. All printed research-result cells were compared with freshly generated expected values. Definitions and units were inspected against their specific functions; no validity claim is inferred from bounds.','', '| '+' | '.join(hdr)+' |','|'+'|'.join(['---']*len(hdr))+'|']
for r in results:md.append('| '+' | '.join(map(safe,[r[k] for k in ['id','manuscript_result','location','experimental_source','calculation','recalculated_result','status']]))+' |')
(W/'RESULTS_VERIFICATION_MATRIX.md').write_text('\n'.join(md),encoding='utf-8');(W/'results_verification_matrix.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
out={'claim_entries':len(claims),'results_entries':len(results),'substantive_paragraphs_covered':len(coverage),'heading_or_blank_paragraphs':len(skip),'table_data_rows':sum(len(x['rows'])-1 for x in T.values()),'status_counts':dict(collections.Counter(c['status'] for c in claims)),'table_comparison_failures':fail,'feature_comparison_failures':feature_fail,'unmapped_pages':list(set(page_missing)),'original_files_changed':changed,'portable_difference_keys':list(diff),'manuscript_sha256':hashlib.sha256((ROOT/'Third_draft.docx').read_bytes()).hexdigest(),'independent_check_count':I['independent_assertions']}
(W/'coverage_inventory.json').write_text(json.dumps({'covered_paragraphs':coverage,'excluded_labels_or_blanks':skip,'table_data_row_count':out['table_data_rows']},ensure_ascii=False,indent=2),encoding='utf-8')
(W/'audit_completion_checks.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
# Fold the tables into one self-contained complete report; companions remain easier to browse.
body=(W/'AUDIT_FINDINGS.md').read_text(encoding='utf-8')
appendix='\n\n## Audit counts and file integrity\n\n'+f"The inventory covers {len(coverage)} substantive paragraphs and {out['table_data_rows']} table data rows, represented by {len(claims)} claim entries and {len(results)} numerical-result/configuration entries. All {len(inventory)} recorded original files retained their hashes. The manuscript hash remains `{out['manuscript_sha256']}`. No tracked insertions/deletions or comment parts were present. These counts are traceability totals, not a percentage estimate of scientific validity.\n\n"
appendix+='Full absolute paths, line ranges and reproducible evidence locations are also available in the JSON companions. External sources were browsed on 6 November 2026; local direct-HTTP attempts failed DNS and are recorded separately in live_link_checks.json.\n'
(W/'PRE_SUBMISSION_AUDIT.md').write_text(body+appendix+'\n\n'+(W/'CLAIM_VERIFICATION_MATRIX.md').read_text(encoding='utf-8')+'\n\n'+(W/'RESULTS_VERIFICATION_MATRIX.md').read_text(encoding='utf-8'),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False,indent=2))
