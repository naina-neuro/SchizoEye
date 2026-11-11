from pathlib import Path
import json,hashlib,ast
W=Path(__file__).resolve().parent
claims=json.loads((W/'claim_verification_matrix.json').read_text())
checks=json.loads((W/'audit_completion_checks.json').read_text())
probes=json.loads((W/'additional_probes.json').read_text())
assert len(probes['tests'])==59
for t in probes['tests']:
    assert t['nan']['lowConfidence']
    assert not t['below']['lowConfidence'] and not t['above']['lowConfidence']
    assert t['below']['value']==t['bounds']['lower'] and t['above']['value']==t['bounds']['upper']
    assert t['bounds']['lower']<=t['nan']['value']<=t['bounds']['upper']
tree=ast.parse((W.parent/'backend'/'app.py').read_text(encoding='utf-8'))
order=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REQUIRED_FEATURES' for t in n.targets))
assert order==json.loads((W/'verification_results.json').read_text())['features']
inventory=json.loads((W/'original_file_inventory.json').read_text())
for entry in inventory:
    assert hashlib.sha256((W.parent/entry['path']).read_bytes()).hexdigest()==entry['sha256'],entry['path']
checks.update(additional_edge_probes_passed=177,backend_feature_order_matches=True,final_original_hashes_checked=len(inventory))
(W/'audit_completion_checks.json').write_text(json.dumps(checks,indent=2))
for c in claims:
    if c['status'] in ['Partial','Contradicted']:print(c['id'],c['location'],c['status'],c['claim'][:100])
print('Final integrity check:',len(inventory),'original files unchanged;',len(claims),'claim entries; all table and independent checks passed.')
