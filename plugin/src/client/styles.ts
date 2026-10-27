// Scoped styles for the microphone activity row and the bundle settings page.
// Colors come from the live Harness theme tokens, with neutral fallbacks.
export const CSS = `
.vs-root{font:inherit;color:inherit}
.vs-trigger{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.vs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}
.vs-trigger[data-active="true"]{color:var(--dsw-alias-brand-primary, #2f6bff)}
.vs-trigger:disabled{opacity:.45;cursor:default}
.vs-row{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.vs-round{flex:none;width:30px;height:30px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);background:var(--dsw-specific-selector, transparent);color:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.vs-round:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}
.vs-timer{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary, #888);min-width:38px}
.vs-meter{display:flex;align-items:flex-end;gap:2px;height:22px;flex:1;min-width:60px}
.vs-meter>span{flex:1;min-width:2px;height:100%;background:var(--dsw-alias-label-tertiary, #666);border-radius:1px;transform-origin:bottom;transform:scaleY(.08);opacity:.35;transition:opacity .08s linear}
.vs-meter>span[data-on="true"]{opacity:1;background:var(--dsw-alias-brand-primary, #2f6bff)}
.vs-meter>span[data-hot="true"]{background:var(--dsw-alias-state-warning-primary, #e0a100)}
.vs-status{font-size:12px;color:var(--dsw-alias-label-secondary, #888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.vs-link{border:0;background:none;color:var(--dsw-alias-brand-primary, #2f6bff);cursor:pointer;font:inherit;font-size:12px;padding:0}
.vs-card{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:1.5}
.vs-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l1, #ffffff14);border-radius:10px}
.vs-section h4{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary, inherit)}
.vs-section summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;outline:none;user-select:none}
.vs-section summary::-webkit-details-marker{display:none}
.vs-section summary::before{content:'▸';font-size:11px;color:var(--dsw-alias-label-tertiary, #777);transition:transform .15s ease}
.vs-section[open] summary::before{transform:rotate(90deg)}
.vs-section summary h4{margin:0}
.vs-subhead{margin:4px 0 0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary, inherit);opacity:.85}
.vs-hint{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary, #777)}
.vs-hint[data-status="ok"]{color:#3fb950}
.vs-hint[data-status="error"]{color:#e5484d}
.vs-hint[data-status="pending"]{color:#d29922}
.vs-line{display:flex;align-items:center;gap:8px;justify-content:space-between}
.vs-line>label{flex:1;min-width:0}
.vs-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vs-input,.vs-select{font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-module-platform, #ffffff08);border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);border-radius:6px;padding:5px 7px;min-width:0}
.vs-input:focus,.vs-select:focus{outline:1px solid var(--dsw-alias-brand-primary, #2f6bff)}
.vs-range{accent-color:var(--dsw-alias-brand-primary, #2f6bff);flex:1;min-width:80px}
.vs-value{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-tertiary, #777);min-width:52px;text-align:right}
.vs-check{display:flex;align-items:center;gap:6px;cursor:pointer}
.vs-btn{font:inherit;font-size:13px;padding:5px 11px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);background:var(--dsw-alias-bg-module-platform, transparent);color:inherit;cursor:pointer}
.vs-btn:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}
.vs-btn[data-kind="primary"]{background:var(--dsw-alias-interactive-bg-active, #ffffff24);color:inherit;border-color:var(--dsw-alias-border-l2, #ffffff1f)}
.vs-btn[data-kind="danger"]{background:#e5484d1f;color:#ff8b90;border-color:#e5484d66}
.vs-btn[data-kind="danger"]:hover{background:#e5484d33}
.vs-live{display:flex;flex-direction:column;gap:6px}
.vs-live-meter{height:10px;border-radius:5px;background:var(--dsw-alias-border-l1, #ffffff1a);overflow:hidden}
.vs-live-meter>span{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#3fb950 0%,#d29922 70%,#e5484d 100%);transition:width .08s linear}
.vs-live-db{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary, #888)}
.vs-overlay{position:fixed;inset:0;z-index:60;background:#00000080;display:flex;align-items:center;justify-content:center;padding:16px}
.vs-modal{width:min(560px,94vw);max-height:86vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);background:var(--dsw-alias-bg-module-platform, #1b1d22);color:var(--dsw-alias-label-primary, inherit);box-shadow:0 24px 60px #00000066}
.vs-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.vs-modal-head h4{margin:0;font-size:14px;font-weight:600}
.vs-footer-action{display:flex;justify-content:flex-end;padding-top:4px}
.vs-reset-list{display:flex;flex-direction:column;gap:6px}
.vs-reset-list ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary, #999)}
.vs-btn:disabled{opacity:.5;cursor:default}
.vs-dict{display:flex;flex-direction:column;gap:6px}
.vs-dict-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px}
.vs-compare-item{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1, #ffffff10)}
.vs-compare-item p{margin:0;font-size:12px;word-break:break-word}
.vs-compare-meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary, #777)}
.vs-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f)}
.vs-error{color:var(--dsw-alias-state-error-primary, #e5484d);font-size:12px}
.vs-progress{display:flex;flex-direction:column;gap:4px}
.vs-progress-bar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1, #ffffff1a);overflow:hidden}
.vs-progress-bar>span{display:block;height:100%;background:var(--dsw-alias-brand-primary, #2f6bff);border-radius:3px;transition:width .2s linear}
.vs-progress-meta{font-size:11px;color:var(--dsw-alias-label-tertiary, #777);font-variant-numeric:tabular-nums}
.vs-trigger-wrap{position:relative;display:inline-flex;align-items:center;gap:1px}
.vs-quick{position:fixed;right:24px;bottom:80px;z-index:70;display:flex;flex-direction:column;gap:10px;width:min(340px,84vw);max-height:66vh;overflow:auto;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);background:var(--dsw-alias-bg-module-platform, #1b1d22);color:var(--dsw-alias-label-primary, inherit);box-shadow:0 18px 48px #00000066;font-size:13px}
.vs-quick-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.vs-quick-head strong{font-size:13.5px}
.vs-quick-actions{display:flex;gap:8px}
.vs-quick-actions .vs-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.vs-quick-block{display:flex;flex-direction:column;gap:6px}
.vs-quick-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary, #999)}
.vs-quick-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1, #ffffff14);padding-top:8px}
.vs-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);border-radius:8px;overflow:hidden}
.vs-seg>button{font:inherit;font-size:12.5px;padding:5px 10px;border:0;background:transparent;color:inherit;cursor:pointer}
.vs-seg>button+button{border-left:.5px solid var(--dsw-alias-border-l2, #ffffff1f)}
.vs-seg>button[data-active="true"]{background:var(--dsw-alias-interactive-bg-active, #ffffff24)}
.vs-seg>button:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}
.vs-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary, #777);margin-right:5px}
.vs-dot[data-status="ok"]{background:#3fb950}
.vs-dot[data-status="error"]{background:#e5484d}
.vs-dot[data-status="pending"]{background:#d29922}
.vs-mode-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary, #777);cursor:pointer}
.vs-mode-badge:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14);color:inherit}
.vs-mode-badge[data-mode="live"]{color:#3fb950}
.vs-mode-badge[data-mode="utterance"]{color:var(--dsw-alias-brand-primary, #2f6bff)}
.vs-mode-chip{flex:none;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);font-size:11.5px;color:var(--dsw-alias-label-secondary, #999);white-space:nowrap}
.vs-mode-chip[data-mode="live"]{color:#3fb950;border-color:#3fb95055}
.vs-mode-chip[data-mode="utterance"]{color:var(--dsw-alias-brand-primary, #2f6bff);border-color:#2f6bff55}
.vs-mode-timer{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary, #888)}
.vs-quick .vs-input,.vs-quick .vs-select{width:100%}
`
