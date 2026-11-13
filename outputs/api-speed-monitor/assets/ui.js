(() => {
  const tabs = [...document.querySelectorAll('.view-tab')];
  const railButtons = [...document.querySelectorAll('.rail-button')];
  const panels = [...document.querySelectorAll('.view-panel')];
  const indicator = document.querySelector('.tab-indicator');
  const demoToggle = document.getElementById('demoToggle');
  const demoBadge = document.getElementById('demoBadge');
  const subtitle = document.querySelector('.workspace-title p');
  const connectionHint = document.getElementById('connectionHint');
  const transport = document.getElementById('transport');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentView = 'overview';
  let demoActive = false;
  let latestUpdate = { running: false, monitoring: false, samples: 0, progress: 0 };

  function alignIndicator() {
    const selected = tabs.find(tab => tab.dataset.view === currentView);
    if (!selected || !indicator) return;
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.transform = `translateX(${selected.offsetLeft - 3}px)`;
  }

  function switchView(view, focus = false) {
    if (!panels.some(panel => panel.id === `view-${view}`)) return;
    currentView = view;
    tabs.forEach(tab => {
      const selected = tab.dataset.view === view;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    railButtons.forEach(button => {
      const selected = button.dataset.view === view;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    panels.forEach(panel => { panel.hidden = panel.id !== `view-${view}`; });
    document.getElementById('currentViewLabel').textContent = {
      overview: '测速工作台', checks: '模型检测', logs: '运行日志'
    }[view];
    alignIndicator();
    requestAnimationFrame(() => window.ApiMonitor?.render());
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
    tab.addEventListener('keydown', event => {
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      switchView(tabs[nextIndex].dataset.view, true);
    });
  });
  railButtons.forEach(button => button.addEventListener('click', () => {
    switchView(button.dataset.view);
    document.querySelector('.workspace').scrollIntoView({ behavior: motionPreference.matches ? 'instant' : 'smooth', block: 'start' });
  }));
  new ResizeObserver(alignIndicator).observe(document.querySelector('.view-tabs'));
  alignIndicator();

  function updateConnectionHint() {
    connectionHint.textContent = transport.value === 'proxy'
      ? '密钥经网站服务器转发但不保存，单次转发最长 60 秒。'
      : '直接连接中转站，密钥不经本站；需要中转站允许浏览器跨域。';
  }
  transport.addEventListener('change', updateConnectionHint);
  updateConnectionHint();

  const showKey = document.getElementById('showKey');
  const apiKey = document.getElementById('apiKey');
  showKey.addEventListener('click', () => {
    const visible = apiKey.type === 'password';
    apiKey.type = visible ? 'text' : 'password';
    showKey.setAttribute('aria-pressed', String(visible));
    showKey.setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
    showKey.title = visible ? '隐藏密钥' : '显示密钥';
  });

  document.querySelectorAll('select').forEach(select => {
    select.addEventListener('change', () => {
      if (motionPreference.matches) return;
      select.classList.remove('field-changed');
      requestAnimationFrame(() => select.classList.add('field-changed'));
    });
    select.addEventListener('animationend', () => select.classList.remove('field-changed'));
  });

  function updateDemo(active) {
    demoActive = active;
    demoToggle.setAttribute('aria-pressed', String(active));
    demoToggle.querySelector('span').textContent = active ? '退出示例' : '示例预览';
    demoBadge.hidden = !active;
    document.body.classList.toggle('demo-mode', active);
    subtitle.textContent = active ? '正在展示模拟数据，不会请求 API 或消耗额度。' : '连接中转站，选择模型，从一次真实响应开始。';
  }

  function updateParameterSummary() {
    const interval = document.getElementById('interval').value;
    const maxTokens = document.getElementById('maxTokens').value;
    const effort = document.getElementById('effort').value;
    document.getElementById('parameterSummary').textContent = `${interval} 分钟间隔 · ${maxTokens} tokens · ${effort || '默认推理强度'}`;
  }
  ['interval', 'maxTokens', 'effort'].forEach(id => document.getElementById(id).addEventListener('input', updateParameterSummary));
  document.getElementById('fileInput').addEventListener('change', () => requestAnimationFrame(updateParameterSummary));
  updateParameterSummary();

  demoToggle.addEventListener('click', () => {
    if (latestUpdate.running || latestUpdate.checksRunning) return;
    if (demoActive) window.ApiMonitor?.clearDemo();
    else {
      window.ApiMonitor?.loadDemo();
      switchView('overview');
    }
  });

  function applyMonitorUpdate(detail) {
    latestUpdate = detail;
    const samples = Number(detail.samples) || 0;
    const active = Boolean(detail.running || detail.checksRunning);
    document.body.classList.toggle('has-samples', samples > 0);
    document.body.classList.toggle('monitoring', active || Boolean(detail.monitoring));
    demoToggle.disabled = active || Boolean(detail.monitoring);
    document.getElementById('sampleCount').textContent = String(samples);
    document.getElementById('modelCount').textContent = `${Number(detail.modelCount) || 0} 个`;
    updateDemo(Boolean(detail.demo));
    const progress = Math.max(0, Math.min(100, Number(detail.progress) || 0));
    document.querySelector('#testProgress span').style.width = `${active ? progress : 0}%`;
    const output = document.getElementById('outputPreview');
    output.hidden = !active || !detail.output;
    if (!output.hidden) output.textContent = String(detail.output).slice(-500);
    const globalStatus = document.getElementById('globalStatus');
    globalStatus.classList.toggle('running', active || Boolean(detail.monitoring));
    if (detail.checksRunning) globalStatus.querySelector('span:last-child').textContent = '模型检测中';
    else if (detail.running && !detail.monitoring) globalStatus.querySelector('span:last-child').textContent = '正在测试';
    document.getElementById('nextRun').textContent = detail.nextRunAt
      ? `下轮 ${new Date(detail.nextRunAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : '';
  }

  document.addEventListener('monitor:update', event => applyMonitorUpdate(event.detail));
  window.ApiMonitor?.render();

  const particlesCanvas = document.getElementById('particles');
  const particleContext = particlesCanvas.getContext('2d');
  const particleToggle = document.getElementById('particleToggle');
  const pointer = { positionX: -1000, positionY: -1000 };
  let particles = [];
  let particleWidth = 0;
  let particleHeight = 0;
  let particleRailWidth = 0;
  let particleFrame = null;
  let lastPaint = 0;
  let particleEnabled = true;

  try { particleEnabled = window.localStorage.getItem('qingce-particles') !== 'off'; } catch {}

  function resizeParticles() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    particleWidth = window.innerWidth;
    particleHeight = window.innerHeight;
    particlesCanvas.width = particleWidth * ratio;
    particlesCanvas.height = particleHeight * ratio;
    particleContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    const rail = document.querySelector('.nav-rail').getBoundingClientRect();
    particleRailWidth = rail.width;
    const count = window.innerWidth > 760 ? 12 : 0;
    particles = Array.from({ length: count }, () => ({
      positionX: 12 + Math.random() * Math.max(10, rail.width - 24),
      positionY: Math.random() * particleHeight,
      radius: .7 + Math.random() * 1.1,
      speedX: (Math.random() - .5) * .1,
      speedY: -.04 - Math.random() * .1,
      opacity: .08 + Math.random() * .13,
      phase: Math.random() * Math.PI * 2
    }));
    particleContext.clearRect(0, 0, particleWidth, particleHeight);
  }

  function drawParticles(timestamp) {
    if (!particleEnabled || motionPreference.matches || document.hidden || !particles.length) {
      particleFrame = null;
      return;
    }
    particleFrame = requestAnimationFrame(drawParticles);
    if (timestamp - lastPaint < 32) return;
    const elapsed = Math.min((timestamp - lastPaint) / 32, 2);
    lastPaint = timestamp;
    particleContext.clearRect(0, 0, particleWidth, particleHeight);
    particles.forEach(particle => {
      particle.positionX += particle.speedX * elapsed + Math.sin(timestamp * .0003 + particle.phase) * .08;
      particle.positionY += particle.speedY * elapsed;
      const distanceX = particle.positionX - pointer.positionX;
      const distanceY = particle.positionY - pointer.positionY;
      const distance = Math.hypot(distanceX, distanceY);
      if (distance > 0 && distance < 70) {
        particle.positionX += distanceX / distance * .15;
        particle.positionY += distanceY / distance * .15;
      }
      if (particle.positionY < -5) particle.positionY = particleHeight + 5;
      if (particle.positionX < 10) particle.positionX = particleRailWidth - 10;
      if (particle.positionX > particleRailWidth - 10) particle.positionX = 10;
      particleContext.beginPath();
      particleContext.arc(particle.positionX, particle.positionY, particle.radius, 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(146, 103, 69, ${particle.opacity * (.65 + .35 * Math.sin(timestamp * .001 + particle.phase))})`;
      particleContext.fill();
    });
  }

  function syncParticles() {
    particleToggle.setAttribute('aria-pressed', String(particleEnabled && !motionPreference.matches));
    particleToggle.disabled = motionPreference.matches;
    particleToggle.title = motionPreference.matches ? '已根据系统的减少动态效果设置暂停粒子' : '开关背景粒子';
    if (particleFrame) cancelAnimationFrame(particleFrame);
    particleFrame = null;
    particleContext.clearRect(0, 0, particleWidth, particleHeight);
    if (particleEnabled && !motionPreference.matches && !document.hidden && particles.length) {
      lastPaint = performance.now();
      particleFrame = requestAnimationFrame(drawParticles);
    }
  }

  particleToggle.addEventListener('click', () => {
    particleEnabled = !particleEnabled;
    try { window.localStorage.setItem('qingce-particles', particleEnabled ? 'on' : 'off'); } catch {}
    syncParticles();
  });
  window.addEventListener('pointermove', event => { pointer.positionX = event.clientX; pointer.positionY = event.clientY; }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.positionX = -1000; pointer.positionY = -1000; });
  window.addEventListener('resize', () => { resizeParticles(); syncParticles(); }, { passive: true });
  document.addEventListener('visibilitychange', syncParticles);
  motionPreference.addEventListener('change', syncParticles);
  resizeParticles();
  syncParticles();
})();
