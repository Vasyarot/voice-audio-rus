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
.vs-pending{display:flex;gap:6px;align-items:center;min-width:0}
.vs-link{border:0;background:none;color:var(--dsw-alias-brand-primary, #2f6bff);cursor:pointer;font:inherit;font-size:12px;padding:0}
.vs-card{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.45}
.vs-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l1, #ffffff14);border-radius:10px}
.vs-section h4{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary, inherit)}
.vs-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary, #777)}
.vs-line{display:flex;align-items:center;gap:8px;justify-content:space-between}
.vs-line>label{flex:1;min-width:0}
.vs-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vs-input,.vs-select{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-module-platform, #ffffff08);border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);border-radius:6px;padding:4px 6px;min-width:0}
.vs-input:focus,.vs-select:focus{outline:1px solid var(--dsw-alias-brand-primary, #2f6bff)}
.vs-range{accent-color:var(--dsw-alias-brand-primary, #2f6bff);flex:1;min-width:80px}
.vs-value{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-tertiary, #777);min-width:52px;text-align:right}
.vs-check{display:flex;align-items:center;gap:6px;cursor:pointer}
.vs-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f);background:var(--dsw-alias-bg-module-platform, transparent);color:inherit;cursor:pointer}
.vs-btn:hover{background:var(--dsw-alias-interactive-bg-hover, #ffffff14)}
.vs-btn[data-kind="primary"]{background:var(--dsw-alias-interactive-bg-active, #ffffff24);color:inherit;border-color:var(--dsw-alias-border-l2, #ffffff1f)}
.vs-live{display:flex;flex-direction:column;gap:6px}
.vs-live-meter{height:10px;border-radius:5px;background:var(--dsw-alias-border-l1, #ffffff1a);overflow:hidden}
.vs-live-meter>span{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#3fb950 0%,#d29922 70%,#e5484d 100%);transition:width .08s linear}
.vs-live-db{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary, #888)}
.vs-btn:disabled{opacity:.5;cursor:default}
.vs-dict{display:flex;flex-direction:column;gap:6px}
.vs-dict-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px}
.vs-history{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.vs-history-item{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1, #ffffff10)}
.vs-history-item p{margin:0;font-size:12px;word-break:break-word}
.vs-history-meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary, #777)}
.vs-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2, #ffffff1f)}
.vs-error{color:var(--dsw-alias-state-error-primary, #e5484d);font-size:12px}
.vs-progress{display:flex;flex-direction:column;gap:4px}
.vs-progress-bar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1, #ffffff1a);overflow:hidden}
.vs-progress-bar>span{display:block;height:100%;background:var(--dsw-alias-brand-primary, #2f6bff);border-radius:3px;transition:width .2s linear}
.vs-progress-meta{font-size:11px;color:var(--dsw-alias-label-tertiary, #777);font-variant-numeric:tabular-nums}
`
