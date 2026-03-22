/**
 * Patch Widget — v1.1.0
 * Custom categories via BUGBOT_CATEGORIES
 * Context capture via BUGBOT_CONTEXT hook
 * Position config: BUGBOT_POSITION + BUGBOT_ANCHOR
 */
(function () {
  const CFG = {
    webhook:    window.BUGBOT_WEBHOOK       || 'http://localhost:3001/bug-report',
    baseUrl:    window.BUGBOT_BASE_URL      || 'http://localhost:3001',
    project:    window.BUGBOT_PROJECT       || 'unknown',
    secret:     window.BUGBOT_SECRET        || '',
    assetsUrl: (window.BUGBOT_ASSETS_URL    || '').replace(/\/$/, ''),
    turnstile:  window.BUGBOT_TURNSTILE_KEY || '',
    triggerIcon:  window.BUGBOT_TRIGGER_ICON  || '🩹',
    triggerColor: window.BUGBOT_TRIGGER_COLOR || 'rgba(200,40,40,0.88)',
    position:   window.BUGBOT_POSITION      || 'bottom-right',
    anchor:     window.BUGBOT_ANCHOR        || '',
    theme:      window.BUGBOT_THEME         || 'dark',
  };

  // Custom categories — or fall back to default three
  const CUSTOM_CATS = window.BUGBOT_CATEGORIES || null;

  // Context hook — app can expose extra data to attach to every report
  const getContext = () => {
    if (typeof window.BUGBOT_CONTEXT === 'function') {
      try { return window.BUGBOT_CONTEXT(); } catch { return {}; }
    }
    return {};
  };

  const asset = n => CFG.assetsUrl ? `${CFG.assetsUrl}/${n}` : null;

  // ── Error capture ──────────────────────────────────────────────────────────
  const _errors = [];
  const _origErr = console.error.bind(console);
  console.error = (...a) => { _errors.push({ ts: new Date().toISOString(), msg: a.map(String).join(' ') }); if (_errors.length > 20) _errors.shift(); _origErr(...a); };
  window.addEventListener('error', e => { _errors.push({ ts: new Date().toISOString(), msg: `${e.message} @ ${e.filename}:${e.lineno}` }); if (_errors.length > 20) _errors.shift(); });
  window.addEventListener('unhandledrejection', e => { _errors.push({ ts: new Date().toISOString(), msg: `Rejection: ${e.reason}` }); if (_errors.length > 20) _errors.shift(); });

  // ── Shadow DOM ─────────────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'patch-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:99999;inset:0;pointer-events:none;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  function triggerPos() {
    const p = CFG.position;
    if (p === 'bottom-right') return 'bottom:24px;right:24px;left:auto;top:auto;';
    if (p === 'top-left')     return 'top:24px;left:24px;bottom:auto;right:auto;';
    if (p === 'top-right')    return 'top:24px;right:24px;bottom:auto;left:auto;';
    return 'bottom:24px;left:24px;top:auto;right:auto;';
  }

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :host{font-family:'Syne',sans-serif}

    #bb-trigger{position:fixed;${triggerPos()}width:32px;height:32px;border-radius:50%;
      background:${CFG.triggerColor};border:2px solid rgba(255,255,255,0.15);
      cursor:pointer;pointer-events:all;transition:all 0.2s;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 12px rgba(0,0,0,0.3);user-select:none}
    #bb-trigger:hover{transform:scale(1.12);filter:brightness(1.2)}
    #bb-trigger.working{background:rgba(200,120,20,0.88);border-color:rgba(240,160,60,0.5);animation:pulse-ring 1.5s ease-in-out infinite}
    #bb-trigger.success{background:rgba(30,160,80,0.88);border-color:rgba(60,200,120,0.5)}
    #bb-trigger.queued {background:rgba(80,140,200,0.88);border-color:rgba(100,170,240,0.5)}
    @keyframes pulse-ring{0%,100%{box-shadow:0 0 8px rgba(220,50,50,0.5)}50%{box-shadow:0 0 20px rgba(220,50,50,0.85)}}

    #bb-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);
      display:flex;align-items:flex-end;justify-content:flex-end;
      padding:24px;opacity:0;pointer-events:none;transition:opacity 0.25s}
    #bb-overlay.open{opacity:1;pointer-events:all}

    #bb-panel{width:340px;max-height:calc(100vh - 48px);overflow-y:auto;
      background:rgba(10,9,7,0.98);border:1px solid rgba(240,237,230,0.1);
      border-radius:16px;overflow:hidden;
      box-shadow:0 24px 64px rgba(0,0,0,0.6);
      transform:translateY(12px) scale(0.98);transition:transform 0.25s;
      display:flex;flex-direction:column}
    #bb-overlay.open #bb-panel{transform:translateY(0) scale(1)}

    .bb-header{padding:13px 15px 11px;border-bottom:1px solid rgba(240,237,230,0.07);
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    .bb-header-left{display:flex;align-items:center;gap:10px}
    .bb-header-mascot{width:32px;height:32px;object-fit:contain;animation:float 3s ease-in-out infinite}
    .bb-header-fallback{width:32px;height:32px;border-radius:8px;background:rgba(212,144,42,0.12);
      border:1px solid rgba(212,144,42,0.2);display:flex;align-items:center;justify-content:center;font-size:15px}
    .bb-title{font-size:13px;font-weight:600;color:rgba(240,237,230,0.92)}
    .bb-sub{font-size:10px;color:rgba(240,237,230,0.28);font-family:'DM Mono',monospace;margin-top:1px}
    .bb-close{width:26px;height:26px;border-radius:7px;background:rgba(240,237,230,0.04);
      border:1px solid rgba(240,237,230,0.08);color:rgba(240,237,230,0.4);cursor:pointer;
      display:flex;align-items:center;justify-content:center;font-size:11px;transition:all .15s}
    .bb-close:hover{background:rgba(240,237,230,0.09);color:rgba(240,237,230,0.85)}

    /* Category screen */
    #bb-cat-screen{padding:14px;display:flex;flex-direction:column;gap:7px}
    .bb-cat-prompt{font-size:11px;color:rgba(240,237,230,0.38);text-align:center;margin-bottom:2px}
    .bb-cat-btn{width:100%;padding:12px 14px;border-radius:11px;cursor:pointer;
      border:1px solid rgba(240,237,230,0.08);background:rgba(240,237,230,0.03);
      display:flex;align-items:center;gap:12px;text-align:left;
      transition:all 0.15s;pointer-events:all}
    .bb-cat-btn:hover{border-color:rgba(212,144,42,0.28);background:rgba(212,144,42,0.05)}
    .bb-cat-icon{font-size:20px;flex-shrink:0;width:28px;text-align:center}
    .bb-cat-title{font-size:12px;font-weight:600;color:rgba(240,237,230,0.88);margin-bottom:2px}
    .bb-cat-desc{font-size:11px;color:rgba(240,237,230,0.35);line-height:1.4}

    /* Form screen */
    #bb-form-screen{display:none}
    #bb-form-screen.show{display:block}
    .bb-body{padding:13px 15px 15px;display:flex;flex-direction:column;gap:10px}
    .bb-label{font-size:10px;font-weight:500;color:rgba(240,237,230,0.35);
      letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px;display:block}
    .bb-textarea{width:100%;background:rgba(240,237,230,0.03);border:1px solid rgba(240,237,230,0.08);
      border-radius:10px;padding:9px 11px;color:rgba(240,237,230,0.88);font-size:12px;
      font-family:'Syne',sans-serif;resize:none;outline:none;transition:border-color .15s;line-height:1.6}
    .bb-textarea::placeholder{color:rgba(240,237,230,0.2)}
    .bb-textarea:focus{border-color:rgba(212,144,42,0.35)}
    .bb-meta{background:rgba(240,237,230,0.02);border:1px solid rgba(240,237,230,0.05);
      border-radius:9px;padding:8px 11px;display:flex;flex-direction:column;gap:4px}
    .bb-meta-row{display:flex;align-items:baseline;gap:8px}
    .bb-meta-key{font-family:'DM Mono',monospace;font-size:10px;color:rgba(240,237,230,0.2);min-width:44px}
    .bb-meta-val{font-family:'DM Mono',monospace;font-size:10px;color:rgba(240,237,230,0.42);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
    .bb-warn{font-family:'DM Mono',monospace;font-size:10px;color:rgba(240,160,80,0.75)}
    .bb-conf{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:8px;
      font-family:'DM Mono',monospace;font-size:10px}
    .bb-conf.high{background:rgba(80,220,120,0.07);border:1px solid rgba(80,220,120,0.2);color:rgba(80,220,120,0.85)}
    .bb-conf.low {background:rgba(240,160,80,0.07);border:1px solid rgba(240,160,80,0.2);color:rgba(240,160,80,0.75)}
    .bb-cdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
    .high .bb-cdot{background:rgba(80,220,120,0.9);box-shadow:0 0 6px rgba(80,220,120,0.5)}
    .low  .bb-cdot{background:rgba(240,160,80,0.9)}
    .bb-context-pill{display:flex;align-items:center;gap:7px;background:rgba(240,237,230,0.03);
      border:1px solid rgba(240,237,230,0.07);border-radius:8px;padding:7px 10px}
    .bb-ctx-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.08em;
      text-transform:uppercase;color:rgba(240,237,230,0.25)}
    .bb-ctx-val{font-family:'DM Mono',monospace;font-size:10px;color:rgba(240,237,230,0.55);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .bb-back{background:none;border:none;font-family:'DM Mono',monospace;font-size:10px;
      letter-spacing:.08em;text-transform:uppercase;color:rgba(240,237,230,0.3);
      cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;transition:color .15s}
    .bb-back:hover{color:rgba(240,237,230,0.65)}
    .bb-submit{width:100%;padding:10px;border-radius:10px;font-size:12px;font-weight:600;
      font-family:'Syne',sans-serif;cursor:pointer;transition:all .2s}
    .bb-submit.s-bug {background:rgba(255,90,90,0.12);border:1px solid rgba(255,90,90,0.28);color:rgba(255,140,140,0.95)}
    .bb-submit.s-bug:hover{background:rgba(255,90,90,0.22);color:#fff}
    .bb-submit.s-feedback{background:rgba(80,180,255,0.1);border:1px solid rgba(80,180,255,0.25);color:rgba(120,190,255,0.95)}
    .bb-submit.s-feedback:hover{background:rgba(80,180,255,0.2);color:#fff}
    .bb-submit.s-feature{background:rgba(180,100,255,0.1);border:1px solid rgba(180,100,255,0.25);color:rgba(200,150,255,0.95)}
    .bb-submit.s-feature:hover{background:rgba(180,100,255,0.2);color:#fff}
    .bb-submit:disabled{opacity:.4;cursor:not-allowed}

    /* Queued screen */
    #bb-queued-screen{display:none;padding:20px 16px;text-align:center;flex-direction:column;align-items:center;gap:10px}
    #bb-queued-screen.show{display:flex}
    .bb-q-icon{font-size:40px;margin-bottom:2px}
    .bb-q-title{font-size:15px;font-weight:600;color:rgba(240,237,230,0.9)}
    .bb-q-desc{font-size:12px;color:rgba(240,237,230,0.38);line-height:1.65;max-width:260px}
    .bb-q-id{font-family:'DM Mono',monospace;font-size:9px;color:rgba(240,237,230,0.2);
      background:rgba(240,237,230,0.03);border:1px solid rgba(240,237,230,0.06);
      padding:3px 10px;border-radius:100px;margin-top:4px}

    /* Status screen */
    #bb-status-screen{display:none}
    #bb-status-screen.show{display:block}
    .bb-status-top{padding:18px 18px 0;display:flex;flex-direction:column;align-items:center;text-align:center}
    .bb-mwrap{width:80px;height:80px;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
    .bb-mimg{width:80px;height:80px;object-fit:contain;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.5));transition:opacity .2s}
    .bb-mfb{width:74px;height:74px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:all .4s}
    .mfb-working{background:rgba(240,160,80,0.1);border:1px solid rgba(240,160,80,0.25)}
    .mfb-ready  {background:rgba(80,180,255,0.1);border:1px solid rgba(80,180,255,0.25)}
    .mfb-success{background:rgba(80,220,120,0.1);border:1px solid rgba(80,220,120,0.25)}
    .mfb-fail   {background:rgba(255,90,90,0.1); border:1px solid rgba(255,90,90,0.25)}
    .mfb-inner{font-size:26px}
    .mfb-working .mfb-inner{animation:spin 1.5s linear infinite;display:block;width:20px;height:20px;
      border-radius:50%;border:2px solid rgba(240,160,80,0.2);border-top-color:rgba(240,160,80,0.9);font-size:0}
    .bb-slabel{font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px;transition:color .3s}
    .sl-working{color:rgba(240,160,80,0.7)}.sl-ready{color:rgba(80,180,255,0.7)}
    .sl-success{color:rgba(80,220,120,0.7)}.sl-fail{color:rgba(255,90,90,0.6)}
    .bb-stitle{font-size:14px;font-weight:600;color:rgba(240,237,230,0.9);margin-bottom:4px;line-height:1.35}
    .bb-sdesc{font-size:11px;color:rgba(240,237,230,0.35);line-height:1.6;max-width:260px}
    .bb-sbottom{padding:12px 18px 18px;display:flex;flex-direction:column}
    .bb-steps{width:100%;display:flex;flex-direction:column}
    .bb-step{display:flex;align-items:center;gap:10px;padding:7px 0;
      border-bottom:1px solid rgba(240,237,230,0.04);transition:all .3s}
    .bb-step:last-child{border-bottom:none}
    .bb-sdot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:all .3s}
    .bb-step.pending .bb-sdot{background:rgba(240,237,230,0.15)}
    .bb-step.active  .bb-sdot{background:rgba(240,160,80,0.9);animation:pulse 1.5s ease-in-out infinite}
    .bb-step.done    .bb-sdot{background:rgba(80,220,120,0.9)}
    .bb-step.skipped .bb-sdot{background:rgba(255,90,90,0.5)}
    .bb-slbl{font-size:11px;font-family:'DM Mono',monospace;transition:color .3s}
    .bb-step.pending .bb-slbl{color:rgba(240,237,230,0.22)}
    .bb-step.active  .bb-slbl{color:rgba(240,160,80,0.9)}
    .bb-step.done    .bb-slbl{color:rgba(240,237,230,0.45)}
    .bb-step.skipped .bb-slbl{color:rgba(255,90,90,0.5)}
    #bb-vblock{width:100%;margin-top:12px;padding:12px;background:rgba(80,180,255,0.05);
      border:1px solid rgba(80,180,255,0.15);border-radius:11px;display:none;flex-direction:column;gap:9px}
    #bb-vblock.show{display:flex}
    .bb-plink{display:flex;align-items:center;justify-content:space-between;
      background:rgba(240,237,230,0.04);border:1px solid rgba(240,237,230,0.08);
      border-radius:7px;padding:7px 10px;font-family:'DM Mono',monospace;font-size:10px;
      color:rgba(80,180,255,0.85);text-decoration:none;overflow:hidden;transition:all .15s}
    .bb-plink:hover{background:rgba(80,180,255,0.08)}
    .bb-plink span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bb-fsum{font-size:11px;color:rgba(240,237,230,0.35);font-style:italic;text-align:center;line-height:1.5}
    .bb-vq{font-size:12px;color:rgba(240,237,230,0.55);text-align:center}
    .bb-vbtns{display:flex;gap:8px}
    .bb-byes,.bb-bno{flex:1;padding:9px;border-radius:8px;font-size:12px;font-weight:600;
      font-family:'Syne',sans-serif;cursor:pointer;transition:all .2s}
    .bb-byes{background:rgba(80,220,120,0.12);border:1px solid rgba(80,220,120,0.35);color:#7ee8a2}
    .bb-byes:hover{background:rgba(80,220,120,0.22);color:#fff}
    .bb-bno{background:rgba(255,90,90,0.09);border:1px solid rgba(255,90,90,0.3);color:#ff8f8f}
    .bb-bno:hover{background:rgba(255,90,90,0.18);color:#fff}
    .bb-mnotice{width:100%;margin-top:10px;background:rgba(240,160,80,0.06);
      border:1px solid rgba(240,160,80,0.15);border-radius:8px;padding:9px 13px;
      font-size:11px;color:rgba(240,160,80,0.7);line-height:1.6;text-align:center}
    .bb-rid{font-family:'DM Mono',monospace;font-size:9px;color:rgba(240,237,230,0.16);
      background:rgba(240,237,230,0.02);border:1px solid rgba(240,237,230,0.05);
      padding:3px 10px;border-radius:100px;margin-top:8px;align-self:center}

    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
    @keyframes bounce{0%,100%{transform:translateY(0) scale(1)}20%{transform:translateY(-12px) scale(1.05)}40%{transform:translateY(-6px) scale(0.98)}60%{transform:translateY(-10px) scale(1.03)}80%{transform:translateY(-3px) scale(0.99)}}
    @keyframes mcast{0%,100%{transform:scale(1) rotate(0deg)}30%{transform:scale(1.08) rotate(-5deg)}70%{transform:scale(1.04) rotate(3deg)}}
    @keyframes mglow{0%,100%{filter:drop-shadow(0 0 4px rgba(255,220,80,0.3))}50%{filter:drop-shadow(0 0 12px rgba(255,220,80,0.7))}}
    .af  {animation:float 3s ease-in-out infinite}
    .ab  {animation:bounce 0.8s ease forwards,float 3s ease-in-out 0.8s infinite}
    .acast{animation:mcast 1.5s ease-in-out infinite,mglow 1.5s ease-in-out infinite}
    .aceleb{animation:bounce 0.6s ease forwards,mglow 1s ease-in-out 0.6s infinite}
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // ── Default category definitions ──────────────────────────────────────────
  const DEFAULT_CATS = [
    { id:'bug',        icon:'🐛', title:"Something's broken",  desc:'Found a bug or error? Let us know.',                  prompt:'Describe what you were doing and what happened.',          type:'bug',      submitText:'Send bug report →' },
    { id:'suggestion', icon:'💡', title:'I have a suggestion', desc:'Something feels off or could work better?',            prompt:"What's on your mind? We'd love to hear your thoughts.",    type:'feedback', submitText:'Send suggestion →'  },
    { id:'feature',    icon:'⭐', title:'Feature request',     desc:'Want something new built? Tell us.',                  prompt:'What would you like to see? What problem does it solve?',  type:'feature',  submitText:'Send request →'     },
  ];

  const CATS = CUSTOM_CATS || DEFAULT_CATS;

  // ── Status config ─────────────────────────────────────────────────────────
  const SCFG = {
    received:              {s:'focused.png',    a:'af',     fe:'👀',fc:'mfb-working',sl:'Received',       sc:'sl-working',t:'Report received',              d:'BugHealer is gearing up...',                       steps:{investigating:'active',fix:'pending',deploy:'pending',verify:'pending'}},
    investigating:         {s:'thinking.png',   a:'acast',  fe:'🔍',fc:'mfb-working',sl:'Investigating',  sc:'sl-working',t:'Reading the codebase...',       d:'Tracing the root cause.',                          steps:{investigating:'active',fix:'pending',deploy:'pending',verify:'pending'}},
    fix_deployed:          {s:'casting.png',    a:'acast',  fe:'⚗️',fc:'mfb-working',sl:'Deploying',      sc:'sl-working',t:'Fix written — deploying...',    d:'Spinning up a test environment.',                  steps:{investigating:'done',fix:'done',deploy:'active',verify:'pending'}},
    awaiting_verification: {s:'casting.png',    a:'acast',  fe:'⚡',fc:'mfb-ready',  sl:'Ready to test',  sc:'sl-ready',  t:'Fix deployed — try it now',     d:"Open the preview and confirm it's resolved.",      steps:{investigating:'done',fix:'done',deploy:'done',verify:'active'}},
    verified:              {s:'celebrating.png',a:'aceleb', fe:'🎉',fc:'mfb-success', sl:'Verified',       sc:'sl-success',t:'All done — thank you!',         d:'The fix is queued for the next deploy.',            steps:{investigating:'done',fix:'done',deploy:'done',verify:'done'}},
    fix_failed:            {s:'retry.png',      a:'af',     fe:'😤',fc:'mfb-working',sl:'Retrying',       sc:'sl-working',t:'Trying a different approach...', d:"First attempt didn't crack it. Going again.",       steps:{investigating:'active',fix:'pending',deploy:'pending',verify:'pending'}},
    manual_review:         {s:'tired.png',      a:'af',     fe:'😴',fc:'mfb-fail',   sl:'Escalated',      sc:'sl-fail',   t:'Developer notified',            d:'This one needs a human eye.',                      steps:{investigating:'skipped',fix:'skipped',deploy:'skipped',verify:'skipped'}},
    cannot_reproduce:      {s:'confused.png',   a:'af',     fe:'🤷',fc:'mfb-fail',   sl:'Needs more info',sc:'sl-fail',   t:'Could not reproduce',           d:"BugHealer couldn't find the cause — flagged.",      steps:{investigating:'skipped',fix:'skipped',deploy:'skipped',verify:'skipped'}},
  };

  // ── Build HTML ────────────────────────────────────────────────────────────
  const idleImg = asset('idle.png');
  const headerMascot = idleImg
    ? `<img class="bb-header-mascot" id="bb-hm" src="${idleImg}" alt="Patch">`
    : `<div class="bb-header-fallback" id="bb-hm">🩹</div>`;

  const catButtons = CATS.map(c => `
    <button class="bb-cat-btn" data-cat="${c.id}">
      <div class="bb-cat-icon">${c.icon}</div>
      <div><div class="bb-cat-title">${c.title}</div><div class="bb-cat-desc">${c.desc}</div></div>
    </button>`).join('');

  const html = `
    <button id="bb-trigger" title="Share feedback">
      <span style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.9);font-family:'DM Mono',monospace;">${CFG.triggerIcon}</span>
    </button>

    <div id="bb-overlay" role="dialog" aria-modal="true">
      <div id="bb-panel">

        <div class="bb-header">
          <div class="bb-header-left">
            ${headerMascot}
            <div><div class="bb-title" id="bb-ptitle">How can we help?</div><div class="bb-sub">${CFG.project}</div></div>
          </div>
          <button class="bb-close" id="bb-close">✕</button>
        </div>

        <!-- Cat screen -->
        <div id="bb-cat-screen">
          <div style="padding:13px 14px 14px;display:flex;flex-direction:column;gap:7px">
            <div class="bb-cat-prompt">What brings you here?</div>
            ${catButtons}
          </div>
        </div>

        <!-- Form screen -->
        <div id="bb-form-screen">
          <div class="bb-body">
            <button class="bb-back" id="bb-back">← Back</button>
            <div id="bb-conf-block" style="display:none"></div>
            <div id="bb-ctx-block" style="display:none"></div>
            <div>
              <div class="bb-label" id="bb-flabel">What happened?</div>
              <textarea class="bb-textarea" id="bb-desc" rows="4" placeholder=""></textarea>
            </div>
            <div id="bb-meta-block">
              <div class="bb-label">Auto-captured</div>
              <div class="bb-meta">
                <div class="bb-meta-row"><span class="bb-meta-key">page</span><span class="bb-meta-val" id="bb-murl"></span></div>
                <div class="bb-meta-row"><span class="bb-meta-key">browser</span><span class="bb-meta-val" id="bb-mbr"></span></div>
                <div class="bb-meta-row"><span class="bb-meta-key">errors</span><span class="bb-meta-val" id="bb-merr"></span></div>
              </div>
            </div>
            <div id="bb-ts-wrap"></div>
            <button class="bb-submit s-bug" id="bb-submit">Send →</button>
          </div>
        </div>

        <!-- Queued screen -->
        <div id="bb-queued-screen">
          <div class="bb-q-icon" id="bb-qi"></div>
          <div class="bb-q-title" id="bb-qt"></div>
          <div class="bb-q-desc"  id="bb-qd"></div>
          <div class="bb-q-id"    id="bb-qid"></div>
        </div>

        <!-- Status screen (auto-agent bugs) -->
        <div id="bb-status-screen">
          <div class="bb-status-top">
            <div class="bb-mwrap" id="bb-mwrap">
              <div class="bb-mfb mfb-working"><span class="mfb-inner"></span></div>
            </div>
            <div class="bb-slabel sl-working" id="bb-sl">Investigating</div>
            <div class="bb-stitle" id="bb-st">Reading the codebase...</div>
            <div class="bb-sdesc"  id="bb-sd">BugHealer is tracing the cause.</div>
          </div>
          <div class="bb-sbottom">
            <div class="bb-steps">
              <div class="bb-step active"  id="step-investigating"><div class="bb-sdot"></div><div class="bb-slbl">Investigating</div></div>
              <div class="bb-step pending" id="step-fix">          <div class="bb-sdot"></div><div class="bb-slbl">Writing fix</div></div>
              <div class="bb-step pending" id="step-deploy">       <div class="bb-sdot"></div><div class="bb-slbl">Deploying preview</div></div>
              <div class="bb-step pending" id="step-verify">       <div class="bb-sdot"></div><div class="bb-slbl">Waiting for sign-off</div></div>
            </div>
            <div id="bb-vblock">
              <a class="bb-plink" id="bb-plink" href="#" target="_blank" rel="noopener">
                <span id="bb-purl">Opening preview...</span><span style="flex-shrink:0;margin-left:6px;opacity:.7">↗</span>
              </a>
              <div class="bb-fsum" id="bb-fsum"></div>
              <div class="bb-vq">Did this fix the issue?</div>
              <div class="bb-vbtns">
                <button class="bb-byes" id="bb-byes">✓ Yes, fixed!</button>
                <button class="bb-bno"  id="bb-bno">✗ Still broken</button>
              </div>
            </div>
            <div class="bb-mnotice" id="bb-mnotice" style="display:none">BugHealer is stumped — a developer has been flagged.</div>
            <div class="bb-rid" id="bb-rid"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  const container = document.createElement('div');
  container.innerHTML = html;
  shadow.appendChild(container);

  const $ = id => shadow.getElementById(id);

  let currentCat = null, reportId = null, pollTimer = null, pollCount = 0;
  const MAX_POLLS = 60;

  // ── Screen switching ───────────────────────────────────────────────────────
  function showScreen(name) {
    ['bb-cat-screen','bb-form-screen','bb-queued-screen','bb-status-screen'].forEach(id => {
      const el = $(id); if (!el) return;
      el.className = id.replace('bb-','');
      if (id === 'bb-form-screen' || id === 'bb-queued-screen' || id === 'bb-status-screen') {
        el.classList.toggle('show', id === name);
      } else {
        el.style.display = id === name ? '' : 'none';
      }
    });
  }

  // ── Category selection ─────────────────────────────────────────────────────
  function selectCat(catId) {
    const cat = CATS.find(c => c.id === catId);
    if (!cat) return;
    currentCat = cat;

    $('bb-ptitle').textContent = cat.title;
    $('bb-flabel').textContent = cat.prompt || 'What happened?';
    $('bb-desc').placeholder = cat.placeholder || cat.prompt || '';
    $('bb-desc').value = '';
    const btn = $('bb-submit');
    btn.textContent = cat.submitText || 'Send →';
    btn.className = `bb-submit s-${cat.type || 'bug'}`;

    // Show meta only for bug-type categories
    const isBugType = cat.type === 'bug';
    $('bb-meta-block').style.display = isBugType ? '' : 'none';
    if (isBugType) {
      $('bb-murl').textContent = window.location.href;
      $('bb-mbr').textContent = (navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge|OPR)\/[\d.]+/) || [navigator.userAgent.slice(0,40)])[0];
      const ec = _errors.length;
      $('bb-merr').innerHTML = ec > 0 ? `<span class="bb-warn">⚠ ${ec} error${ec>1?'s':''}</span>` : 'none';
    }

    // Confidence badge for bug-type
    const cb = $('bb-conf-block');
    if (isBugType) {
      const hasErr = _errors.length > 0;
      cb.style.display = '';
      cb.innerHTML = hasErr
        ? `<div class="bb-conf high"><div class="bb-cdot"></div>Console errors found — agent runs automatically</div>`
        : `<div class="bb-conf low"><div class="bb-cdot"></div>No console errors — will be queued for review</div>`;
    } else { cb.style.display = 'none'; }

    // Context pill — show app state if available
    const ctx = getContext();
    const ctxBlock = $('bb-ctx-block');
    const ctxEntries = Object.entries(ctx).filter(([,v]) => v !== null && v !== undefined && String(v).length > 0);
    if (ctxEntries.length) {
      ctxBlock.style.display = '';
      ctxBlock.innerHTML = ctxEntries.map(([k,v]) => `
        <div class="bb-context-pill">
          <span class="bb-ctx-label">${k}</span>
          <span class="bb-ctx-val">${String(v).slice(0,60)}</span>
        </div>`).join('');
    } else { ctxBlock.style.display = 'none'; }

    showScreen('bb-form-screen');
    setTimeout(() => $('bb-desc').focus(), 180);
  }

  // ── Mascot ─────────────────────────────────────────────────────────────────
  function setMascot(s, a, fe, fc) {
    const wrap = $('bb-mwrap'); if (!wrap) return;
    const src = asset(s);
    wrap.innerHTML = src
      ? `<img class="bb-mimg ${a}" src="${src}" alt="Patch">`
      : `<div class="bb-mfb ${fc}"><span class="mfb-inner">${fe}</span></div>`;
  }

  // ── Turnstile ──────────────────────────────────────────────────────────────
  let _tsToken = '', _tsId = null;
  function initTS() {
    if (!CFG.turnstile) return;
    const c = $('bb-ts-wrap'); if (!c || _tsId !== null) return;
    if (!window.turnstile) {
      if (!document.getElementById('cf-ts')) {
        const s = document.createElement('script');
        s.id = 'cf-ts'; s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        s.async = true; s.defer = true; s.onload = initTS;
        document.head.appendChild(s);
      }
      return;
    }
    _tsId = window.turnstile.render(c, {
      sitekey: CFG.turnstile, theme: 'dark', size: 'compact',
      callback: t => _tsToken = t,
      'expired-callback': () => _tsToken = '',
      'error-callback':   () => _tsToken = '',
    });
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function openPanel() {
    $('bb-ptitle').textContent = 'How can we help?';
    currentCat = null;
    showScreen('bb-cat-screen');
    $('bb-overlay').classList.add('open');
    initTS();
  }
  function closePanel() { $('bb-overlay').classList.remove('open'); }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function submit() {
    const desc = $('bb-desc').value.trim();
    if (!desc) { $('bb-desc').focus(); return; }
    const btn = $('bb-submit');
    btn.disabled = true; btn.textContent = 'Sending...';

    const isBugType = currentCat?.type === 'bug';
    const hasErrors = isBugType && _errors.length > 0;
    const confidence = hasErrors ? 'verified' : 'unverified';
    const ctx = getContext();

    // Build description — prefix with category ID for dashboard readability
    const fullDesc = `[${(currentCat?.id || 'bug').toUpperCase()}] ${desc}`;

    const payload = {
      id: `${currentCat?.id || 'bug'}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      project: CFG.project,
      description: fullDesc,
      category: currentCat?.id || 'bug',
      confidence,
      url: window.location.href,
      browser: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString(),
      consoleErrors: isBugType ? _errors.slice(-10) : [],
      context: ctx,
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (CFG.secret) headers['x-bugbot-secret'] = CFG.secret;
      if (_tsToken)   headers['x-turnstile-token'] = _tsToken;
      const res = await fetch(CFG.webhook, { method:'POST', headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reportId = payload.id;

      if (isBugType && confidence === 'verified') {
        $('bb-rid').textContent = `ID: ${reportId}`;
        showScreen('bb-status-screen');
        $('bb-trigger').classList.add('working');
        startPolling();
      } else {
        const msgs = {
          bug:        { i:'📋', t:'Added to review queue',  d:"We've logged this and it'll be reviewed shortly." },
          suggestion: { i:'💡', t:'Suggestion received!',   d:'Your idea has been added to our feedback board.' },
          feature:    { i:'⭐', t:'Feature request logged!',d:"We'll review it — great products are built by people who care." },
        };
        const catType = currentCat?.type || 'bug';
        const queueMsg = msgs[currentCat?.id] || msgs[catType] || msgs.bug;
        $('bb-qi').textContent = queueMsg.i;
        $('bb-qt').textContent = queueMsg.t;
        $('bb-qd').textContent = queueMsg.d;
        $('bb-qid').textContent = `ID: ${reportId}`;
        showScreen('bb-queued-screen');
        $('bb-trigger').classList.add('queued');
        setTimeout(() => $('bb-trigger').classList.remove('queued'), 4000);
      }
    } catch {
      btn.disabled = false; btn.textContent = 'Failed — retry?';
      btn.style.borderColor = 'rgba(255,90,90,0.5)';
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  function startPolling() { pollCount = 0; pollTimer = setInterval(poll, 10000); poll(); }
  function stopPolling()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function poll() {
    if (!reportId || pollCount >= MAX_POLLS) { stopPolling(); return; }
    pollCount++;
    try {
      const data = await fetch(`${CFG.baseUrl}/bug-reports/${reportId}/status`).then(r => r.json());
      applyStatus(data);
      if (['verified','manual_review','cannot_reproduce'].includes(data.status)) stopPolling();
    } catch {}
  }

  function applyStatus(data) {
    const cfg = SCFG[data.status] || SCFG.investigating;
    setMascot(cfg.s, cfg.a, cfg.fe, cfg.fc);
    const hmEl = $('bb-hm');
    if (hmEl && hmEl.tagName === 'IMG') { const src = asset(cfg.s); if (src) hmEl.src = src; }
    const sl = $('bb-sl'); sl.textContent = cfg.sl; sl.className = `bb-slabel ${cfg.sc}`;
    $('bb-st').textContent = cfg.t;
    $('bb-sd').textContent = cfg.d;
    Object.entries(cfg.steps).forEach(([k, s]) => { const el = $(`step-${k}`); if (el) el.className = `bb-step ${s}`; });
    const vb = $('bb-vblock');
    if (data.status === 'awaiting_verification' && data.previewUrl) {
      vb.classList.add('show');
      $('bb-plink').href = data.previewUrl;
      $('bb-purl').textContent = data.previewUrl.replace(/^https?:\/\//,'').slice(0,40);
      if (data.fixSummary) $('bb-fsum').textContent = `"${data.fixSummary}"`;
    } else { vb.classList.remove('show'); }
    if (['manual_review','cannot_reproduce'].includes(data.status)) $('bb-mnotice').style.display = 'block';
    if (data.status === 'verified') { $('bb-trigger').classList.remove('working'); $('bb-trigger').classList.add('success'); }
    else if (['manual_review','cannot_reproduce'].includes(data.status)) $('bb-trigger').classList.remove('working');
  }

  async function sendVerify(resolved) {
    $('bb-byes').disabled = $('bb-bno').disabled = true;
    try {
      await fetch(`${CFG.baseUrl}/bug-reports/${reportId}/verify`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ resolved }),
      });
      if (resolved) applyStatus({ status:'verified' });
      else {
        applyStatus({ status:'fix_failed' });
        $('bb-vblock').classList.remove('show');
        $('bb-byes').disabled = $('bb-bno').disabled = false;
        startPolling();
      }
    } catch { $('bb-byes').disabled = $('bb-bno').disabled = false; }
  }

  // ── Anchor mode ────────────────────────────────────────────────────────────
  if (CFG.anchor) {
    const anchorEl = document.querySelector(CFG.anchor);
    if (anchorEl) {
      const trig = $('bb-trigger');
      trig.style.position = 'static';
      trig.style.width = '26px';
      trig.style.height = '26px';
      const wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;align-items:center;margin-left:8px;vertical-align:middle;';
      anchorEl.parentNode.insertBefore(wrap, anchorEl.nextSibling);
      wrap.appendChild(trig);
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  $('bb-trigger').addEventListener('click', openPanel);
  $('bb-close').addEventListener('click', closePanel);
  $('bb-overlay').addEventListener('click', e => { if (e.target === $('bb-overlay')) closePanel(); });
  shadow.querySelectorAll('.bb-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => selectCat(btn.dataset.cat));
  });
  $('bb-back').addEventListener('click', () => { showScreen('bb-cat-screen'); $('bb-ptitle').textContent = 'How can we help?'; });
  $('bb-submit').addEventListener('click', submit);
  $('bb-byes').addEventListener('click', () => sendVerify(true));
  $('bb-bno').addEventListener('click',  () => sendVerify(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
})();
