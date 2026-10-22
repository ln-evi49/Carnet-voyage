// Synchronisation en temps réel du carnet de voyage (Firebase / Firestore).
// Un voyage = un document "trips/<code secret>". Le code est le seul "mot de passe" :
// toute personne qui le connaît peut lire et modifier le voyage.
(function(){
  var FB_VER = '10.12.2';
  var FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/';
  var CODE_KEY = 'trip-sync-code';
  var CLIENT_KEY = 'trip-sync-client';
  var DIRTY_KEY = 'trip-sync-dirty';
  var ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 signes, sans l/o/0/1

  function rand(n){
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    var s = '';
    for(var i = 0; i < n; i++) s += ALPHABET[a[i] % ALPHABET.length];
    return s;
  }

  var clientId = localStorage.getItem(CLIENT_KEY);
  if(!clientId){ clientId = rand(16); localStorage.setItem(CLIENT_KEY, clientId); }

  var sync = { status: 'loading', detail: '', code: localStorage.getItem(CODE_KEY) || '', ready: false };
  window.__sync = sync;

  var load = window.__FB_LOADER || function(u){ return import(u); };
  var db = null, fs = null, unsub = null, pushTimer = null, joining = false, inflight = 0;

  function setStatus(status, detail){
    sync.status = status;
    sync.detail = detail || '';
    if(typeof window.onSyncStatus === 'function') window.onSyncStatus();
  }

  function disconnectListener(){
    if(unsub){ try{ unsub(); }catch(e){} unsub = null; }
  }

  function dirtyTs(){ return Number(localStorage.getItem(DIRTY_KEY) || 0); }

  function schedulePush(immediate){
    if(!sync.code || !db || !fs || joining) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, immediate ? 0 : 800);
  }

  function doPush(){
    if(!sync.code || !db || !fs || joining) return Promise.resolve();
    var payload = window.getSyncPayload();
    if(payload.length > 700000){ setStatus('toobig'); return Promise.resolve(); }
    var ts = dirtyTs();
    inflight++;
    return fs.setDoc(fs.doc(db, 'trips', sync.code), { payload: payload, updatedAt: Date.now(), clientId: clientId })
      .then(function(){ inflight--; if(dirtyTs() === ts) localStorage.removeItem(DIRTY_KEY); })
      .catch(function(e){ inflight--; setStatus('error', (e && (e.code || e.message)) || ''); });
  }

  function connect(code, opts){
    opts = opts || {};
    disconnectListener();
    sync.code = code;
    localStorage.setItem(CODE_KEY, code);
    joining = !!opts.join;
    setStatus('connecting');
    var ref = fs.doc(db, 'trips', code);
    unsub = fs.onSnapshot(ref, { includeMetadataChanges: true }, function(snap){
      if(snap.metadata.hasPendingWrites) return;
      if(snap.metadata.fromCache){
        setStatus(navigator.onLine === false ? 'offline' : 'connecting');
        return;
      }
      if(!snap.exists()){
        if(opts.join){
          joining = false;
          disconnectListener();
          sync.code = '';
          localStorage.removeItem(CODE_KEY);
          setStatus('notfound');
          return;
        }
        if(!inflight) doPush();   // document absent et aucun envoi en cours : on le (re)crée
        setStatus('connecting');
        return;
      }
      var d = snap.data();
      var dirty = dirtyTs();
      if(dirty && !opts.join){
        if(d.clientId === clientId && d.updatedAt >= dirty){
          localStorage.removeItem(DIRTY_KEY);
        } else {
          doPush();               // des modifications locales n'étaient pas encore envoyées : elles l'emportent
          setStatus('connecting');
          return;
        }
      }
      joining = false;
      setStatus('on');
      if(d.clientId === clientId) return;
      if(typeof d.payload === 'string') window.applyRemoteState(d.payload);
    }, function(err){
      setStatus('error', (err && (err.code || err.message)) || '');
    });
  }

  window.__syncSchedule = function(){ schedulePush(false); };

  window.__syncCreate = function(){
    if(!sync.ready) return;
    disconnectListener();
    clearTimeout(pushTimer);
    var code = rand(24);
    sync.code = code;
    localStorage.setItem(CODE_KEY, code);
    localStorage.removeItem(DIRTY_KEY);
    joining = false;
    doPush();
    connect(code, { join: false });
  };

  window.__syncJoin = function(code){
    if(!sync.ready) return;
    clearTimeout(pushTimer);
    localStorage.removeItem(DIRTY_KEY);
    connect(code, { join: true });
  };

  window.__syncDisconnect = function(){
    disconnectListener();
    clearTimeout(pushTimer);
    joining = false;
    sync.code = '';
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(DIRTY_KEY);
    setStatus(sync.ready ? 'off' : sync.status);
  };

  function handleUrlCode(){
    var p;
    try{ p = new URLSearchParams(location.search).get('code'); }catch(e){ return; }
    if(!p) return;
    try{ history.replaceState(null, '', location.pathname + location.hash); }catch(e){}
    p = p.toLowerCase();
    if(!/^[a-z0-9]{16,40}$/.test(p) || p === sync.code) return;
    if(confirm('Rejoindre le voyage partagé ? Les données de cet appareil seront remplacées par celles du voyage partagé.')){
      window.__syncJoin(p);
    }
  }

  function init(){
    var cfg = window.FIREBASE_CONFIG;
    if(!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('COLLER') === 0){ setStatus('unconfigured'); return Promise.resolve(); }
    return Promise.all([load(FB_BASE + 'firebase-app.js'), load(FB_BASE + 'firebase-firestore.js')]).then(function(mods){
      var app = mods[0].initializeApp(cfg);
      fs = mods[1];
      try{
        db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
      }catch(e){
        db = fs.getFirestore(app);
      }
      sync.ready = true;
      if(sync.code) connect(sync.code, { join: false });
      else setStatus('off');
      handleUrlCode();
    }).catch(function(e){
      setStatus('unavailable', (e && e.message) || '');
    });
  }

  window.__syncInit = init;
  init();
})();
