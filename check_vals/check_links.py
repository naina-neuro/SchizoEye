from concurrent.futures import ThreadPoolExecutor
import urllib.request,urllib.error,json
from pathlib import Path
W=Path(__file__).resolve().parent
urls=[
'https://api.crossref.org/works/10.1038/nrn1345',
'https://api.crossref.org/works/10.3758/s13428-017-0913-7',
'https://api.crossref.org/works/10.3758/s13428-023-02237-8',
'https://api.crossref.org/works/10.1162/opmi_a_00171',
'https://api.crossref.org/works/10.1016/S0042-6989(03)00084-1',
'https://api.crossref.org/works/10.1145/2939672.2939785',
'https://github.com/naina-neuro/SchizoEyeClassification',
'https://github.com/naina-neuro/SchizoEyeClassification/blob/main/revision_work/verify_pipeline.cjs',
'https://ijcai.org/proceedings/2016/540',
'https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/']
def fetch(url):
    try:
        req=urllib.request.Request(url,headers={'User-Agent':'ManuscriptVerification/1.0 (read-only)'})
        with urllib.request.urlopen(req,timeout=15) as r:
            body=r.read();o={'url':url,'status':r.status,'final_url':r.url,'bytes':len(body)}
            if 'crossref' in url:
                m=json.loads(body)['message'];o['metadata']={k:m.get(k) for k in ['DOI','title','author','container-title','page','volume','issue','published','published-print','published-online']}
            return o
    except urllib.error.HTTPError as e:return {'url':url,'status':e.code,'error':str(e)}
    except Exception as e:return {'url':url,'status':None,'error':str(e)}
with ThreadPoolExecutor(max_workers=10) as pool:out=list(pool.map(fetch,urls))
(W/'live_link_checks.json').write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
