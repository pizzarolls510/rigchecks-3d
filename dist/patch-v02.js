// RigCheck 3D v0.2 — static-pose behavior and upload-overlay fix.
(() => {
  const dropPrompt = document.querySelector('#dropPrompt');
  const fileInput = document.querySelector('#fileInput');
  const canvas = document.querySelector('#viewport');
  const clipSelect = document.querySelector('#clipSelect');
  const loopToggle = document.querySelector('#loopToggle');
  const clipSection = document.querySelector('.clip-section');
  const stage = document.querySelector('#dropZone');

  if (!clipSelect || !clipSection || !stage) return;

  const poseHint = document.createElement('p');
  poseHint.className = 'pose-hint';
  poseHint.hidden = true;
  poseHint.innerHTML = '<strong>Static pose mode.</strong> No animation is required — drag the model view to orbit, pinch to zoom, use camera presets, toggle the skeleton/grid, or capture a frame.';
  clipSection.appendChild(poseHint);

  const viewportHint = document.createElement('div');
  viewportHint.className = 'pose-viewport-hint';
  viewportHint.hidden = true;
  viewportHint.innerHTML = '<b>STATIC POSE</b> · drag to orbit · pinch to zoom';
  stage.appendChild(viewportHint);

  let interactionTimer = null;

  function isStaticModel() {
    if (!clipSelect.disabled) return false;
    const text = (clipSelect.options[0]?.textContent || '').toLowerCase();
    return text.includes('no animation') || text.includes('static pose');
  }

  function syncMode() {
    const isStatic = isStaticModel();
    document.body.classList.toggle('static-model', isStatic);
    poseHint.hidden = !isStatic;
    viewportHint.hidden = !isStatic;

    if (loopToggle) loopToggle.disabled = isStatic;

    if (isStatic && clipSelect.options[0]) {
      clipSelect.options[0].textContent = 'Static pose · no animation';
    }

    if (!isStatic) {
      clearTimeout(interactionTimer);
      viewportHint.hidden = true;
    }
  }

  // iOS Safari was visually showing the drag target because the CSS display rule
  // overrode the native [hidden] behavior. The CSS patch fixes that; these guards
  // also make sure it disappears immediately when a file is chosen or the view is used.
  fileInput?.addEventListener('change', () => {
    if (dropPrompt) dropPrompt.hidden = true;
    setTimeout(syncMode, 0);
    setTimeout(syncMode, 250);
  });

  canvas?.addEventListener('pointerdown', () => {
    if (dropPrompt) dropPrompt.hidden = true;
    if (document.body.classList.contains('static-model')) {
      clearTimeout(interactionTimer);
      interactionTimer = setTimeout(() => {
        viewportHint.hidden = true;
      }, 600);
    }
  }, { passive: true });

  const observer = new MutationObserver(syncMode);
  observer.observe(clipSelect, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

  const sourceLabel = document.querySelector('#sourceLabel');
  const modelLabel = document.querySelector('#modelLabel');
  if (sourceLabel) observer.observe(sourceLabel, { childList: true, characterData: true, subtree: true });
  if (modelLabel) observer.observe(modelLabel, { childList: true, characterData: true, subtree: true });

  syncMode();
})();
