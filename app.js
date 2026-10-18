const elements = {
  loginStage: document.getElementById('loginStage'),
  dashboardStage: document.getElementById('dashboardStage'),
  memberTab: document.getElementById('memberLoginTab'),
  adminTab: document.getElementById('adminLoginTab'),
  loginForm: document.getElementById('loginForm'),
  accessCode: document.getElementById('accessCode'),
  accessPasswordField: document.getElementById('accessPasswordField'),
  accessPassword: document.getElementById('accessPassword'),
  loginMessage: document.getElementById('loginMessage'),
  dashboardRoleLabel: document.getElementById('dashboardRoleLabel'),
  greeting: document.getElementById('memberGreeting'),
  codeDisplay: document.getElementById('memberCodeDisplay'),
  sidebarMemberName: document.getElementById('sidebarMemberName'),
  dashboardMemberName: document.getElementById('dashboardMemberName'),
  memberStatusValue: document.getElementById('memberStatusValue'),
  memberAccessValue: document.getElementById('memberAccessValue'),
  memberCodeRow: document.getElementById('memberCodeRow'),
  memberCodeValue: document.getElementById('memberCodeValue'),
  memberVerification: document.getElementById('memberVerification'),
  memberIdentity: document.getElementById('memberIdentity'),
  adminIdentity: document.getElementById('adminIdentity'),
  adminPanel: document.getElementById('adminPanel'),
  adminNavLink: document.getElementById('adminNavLink'),
  noticesNavLink: document.getElementById('noticesNavLink'),
  pointsNavLink: document.getElementById('pointsNavLink'),
  taskPanel: document.getElementById('tasksPanel'),
  activityPanel: document.getElementById('activityPanel'),
  checkinPanel: document.getElementById('checkinPanel'),
  noticesPanel: document.getElementById('noticesPanel'),
  pointsPanel: document.getElementById('pointsPanel'),
  pointsCard: document.getElementById('pointsCard'),
  pointsBalance: document.getElementById('pointsBalance'),
  memberPointsHistory: document.getElementById('memberPointsHistory'),
  adminPointsHistory: document.getElementById('adminPointsHistory'),
  eventsPanel: document.getElementById('eventsPanel'),
  eventList: document.getElementById('eventList'),
  eventMessage: document.getElementById('eventMessage'),
  checkinForm: document.getElementById('checkinForm'),
  checkinNote: document.getElementById('checkinNote'),
  checkinMessage: document.getElementById('checkinMessage'),
  checkinHistory: document.getElementById('checkinHistory'),
  activityCount: document.getElementById('activityCount'),
  lastCheckIn: document.getElementById('lastCheckIn'),
  activityList: document.getElementById('activityList'),
  taskForm: document.getElementById('taskForm'),
  taskInput: document.getElementById('taskInput'),
  taskList: document.getElementById('taskList'),
  taskMessage: document.getElementById('taskMessage'),
  memberForm: document.getElementById('memberForm'),
  memberDirectory: document.getElementById('memberDirectory'),
  recoverMemberForm: document.getElementById('recoverMemberForm'),
  announcementForm: document.getElementById('announcementForm'),
  announcementList: document.getElementById('announcementList'),
  eventForm: document.getElementById('eventForm'),
  adminActivityList: document.getElementById('adminActivityList'),
  exportBackupButton: document.getElementById('exportBackupButton'),
  backupMessage: document.getElementById('backupMessage'),
  adminMessage: document.getElementById('adminMessage'),
  disciplineForm: document.getElementById('disciplineForm'),
  disciplineMember: document.getElementById('disciplineMember'),
  disciplineType: document.getElementById('disciplineType'),
  disciplineDetails: document.getElementById('disciplineDetails'),
  disciplineMessage: document.getElementById('disciplineMessage'),
  pointsForm: document.getElementById('pointsForm'),
  pointsMember: document.getElementById('pointsMember'),
  pointsDelta: document.getElementById('pointsDelta'),
  pointsReason: document.getElementById('pointsReason'),
  pointsMessage: document.getElementById('pointsMessage'),
  memberNoticeList: document.getElementById('memberNoticeList'),
  adminNoticeList: document.getElementById('adminNoticeList'),
  passwordForm: document.getElementById('passwordForm'),
  passwordPanel: document.getElementById('passwordPanel'),
  passwordMessage: document.getElementById('passwordMessage'),
  logoutBtn: document.getElementById('logoutBtn')
};

let loginMode = 'member';
let state = null;

function normalizeCode(value) {
  const code = value.trim().toUpperCase().replace(/\s+/g, '');
  return code.startsWith('XSOL-') ? code : `XSOL-${code}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function setMessage(element, message) {
  if (element) element.textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (options.download) {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'The request could not be completed.');
    }
    return response.blob();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}

async function refreshState() {
  const response = await api('/api/state');
  state = response.state;
  renderDashboard();
}

function appendEmpty(container, message) {
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = message;
  container.append(empty);
}

function renderTimeline(container, entries, emptyMessage, textKey) {
  container.replaceChildren();
  if (!entries?.length) {
    appendEmpty(container, emptyMessage);
    return;
  }
  entries.forEach((entry) => {
    const item = document.createElement('li');
    const message = document.createElement('span');
    const time = document.createElement('time');
    item.className = 'timeline-item';
    message.className = 'activity-label';
    message.textContent = entry[textKey];
    time.className = 'activity-time';
    time.dateTime = entry.createdAt;
    time.textContent = formatDate(entry.createdAt);
    item.append(message, time);
    container.append(item);
  });
}

function renderTasks() {
  elements.taskList.replaceChildren();
  if (!state.tasks.length) {
    appendEmpty(elements.taskList, 'No tasks yet. Add one above.');
    return;
  }
  state.tasks.forEach((task) => {
    const item = document.createElement('li');
    const checkbox = document.createElement('input');
    const label = document.createElement('span');
    const remove = document.createElement('button');
    item.className = task.done ? 'task-item is-complete' : 'task-item';
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.dataset.taskId = task.id;
    checkbox.setAttribute('aria-label', `Mark ${task.text} ${task.done ? 'incomplete' : 'complete'}`);
    label.className = 'task-label';
    label.textContent = task.text;
    remove.type = 'button';
    remove.className = 'task-remove';
    remove.dataset.removeTask = task.id;
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove task: ${task.text}`);
    item.append(checkbox, label, remove);
    elements.taskList.append(item);
  });
}

function renderEvents() {
  elements.eventList.replaceChildren();
  if (!state.events.length) {
    appendEmpty(elements.eventList, 'No upcoming events have been scheduled.');
    return;
  }
  state.events.forEach((eventEntry) => {
    const card = document.createElement('article');
    const heading = document.createElement('h4');
    const date = document.createElement('time');
    const details = document.createElement('p');
    const reminder = document.createElement('span');
    card.className = 'event-item';
    heading.textContent = eventEntry.title;
    date.dateTime = eventEntry.startsAt;
    date.textContent = formatDate(eventEntry.startsAt);
    details.textContent = eventEntry.details || '';
    const days = Math.ceil((Date.parse(eventEntry.startsAt) - Date.now()) / 86400000);
    reminder.className = 'event-reminder';
    reminder.textContent = days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
    card.append(heading, date, reminder);
    if (eventEntry.details) card.append(details);

    if (state.user.role === 'admin') {
      const summary = document.createElement('p');
      const remove = document.createElement('button');
      summary.className = 'event-attendance-summary';
      summary.textContent = `${eventEntry.rsvpCount} RSVP${eventEntry.rsvpCount === 1 ? '' : 's'} · ${eventEntry.attendeeCount} attended`;
      remove.type = 'button';
      remove.className = 'task-remove';
      remove.dataset.deleteEvent = eventEntry.id;
      remove.textContent = 'Remove event';
      card.append(summary, remove);
    } else {
      const actions = document.createElement('div');
      const rsvpButton = document.createElement('button');
      actions.className = 'event-actions';
      rsvpButton.type = 'button';
      rsvpButton.className = 'secondary-button';
      rsvpButton.dataset.eventAction = eventEntry.rsvped ? 'cancel-rsvp' : 'rsvp';
      rsvpButton.dataset.eventId = eventEntry.id;
      rsvpButton.textContent = eventEntry.rsvped ? 'Cancel RSVP' : 'RSVP';
      actions.append(rsvpButton);
      if (Date.parse(eventEntry.startsAt) <= Date.now() && eventEntry.rsvped && !eventEntry.attended) {
        const attend = document.createElement('button');
        attend.type = 'button';
        attend.className = 'secondary-button';
        attend.dataset.eventAction = 'attendance';
        attend.dataset.eventId = eventEntry.id;
        attend.textContent = 'Confirm attendance';
        actions.append(attend);
      } else if (eventEntry.attended) {
        const confirmed = document.createElement('span');
        confirmed.className = 'attendance-confirmed';
        confirmed.textContent = 'Attendance confirmed';
        actions.append(confirmed);
      }
      card.append(actions);
    }
    elements.eventList.append(card);
  });
}

function renderAnnouncements() {
  elements.announcementList.replaceChildren();
  if (!state.announcements.length) {
    appendEmpty(elements.announcementList, 'No announcements have been posted.');
    return;
  }
  state.announcements.forEach((announcement) => {
    const article = document.createElement('article');
    const heading = document.createElement('h4');
    const time = document.createElement('time');
    const body = document.createElement('p');
    article.className = 'announcement-item';
    heading.textContent = announcement.title;
    time.dateTime = announcement.createdAt;
    time.textContent = formatDate(announcement.createdAt);
    body.textContent = announcement.body;
    article.append(heading, time, body);
    elements.announcementList.append(article);
  });
}

function renderMembers() {
  elements.memberDirectory.replaceChildren();
  elements.disciplineMember.replaceChildren();
  elements.pointsMember.replaceChildren();
  [elements.disciplineMember, elements.pointsMember].forEach((select) => {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a member';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);
  });
  const members = state.members || [];
  if (!members.length) {
    appendEmpty(elements.memberDirectory, 'No member accounts have been added.');
    return;
  }
  members.forEach((member) => {
    const row = document.createElement('div');
    const details = document.createElement('div');
    const name = document.createElement('strong');
    const code = document.createElement('span');
    const points = Number.isSafeInteger(member.points) ? member.points : 0;
    const toggle = document.createElement('button');
    name.textContent = member.name;
    code.textContent = `${member.code} · ${member.status} · ${points} points`;
    details.append(name, code);
    toggle.type = 'button';
    toggle.className = 'secondary-button compact-button';
    toggle.dataset.memberCode = member.code;
    toggle.dataset.memberStatus = member.status;
    toggle.textContent = member.status === 'Active' ? 'Suspend' : 'Reactivate';
    row.className = 'member-row';
    row.append(details, toggle);
    elements.memberDirectory.append(row);

    const option = document.createElement('option');
    option.value = member.code;
    option.textContent = `${member.name} (${member.code})`;
    elements.disciplineMember.append(option.cloneNode(true));
    elements.pointsMember.append(option);
  });
}

function renderNotices() {
  elements.memberNoticeList.replaceChildren();
  elements.adminNoticeList.replaceChildren();
  const notices = state.notices || [];
  if (state.user.role === 'member') {
    if (!notices.length) appendEmpty(elements.memberNoticeList, 'You have no warnings or violations on record.');
    notices.forEach((notice) => {
      const article = document.createElement('article');
      const heading = document.createElement('h4');
      const metadata = document.createElement('div');
      const type = document.createElement('span');
      const status = document.createElement('span');
      const time = document.createElement('time');
      const details = document.createElement('p');
      article.className = `notice-item notice-${notice.type.toLowerCase()}`;
      heading.textContent = notice.type;
      metadata.className = 'notice-meta';
      type.className = 'notice-type';
      type.textContent = notice.type;
      status.className = 'notice-status';
      status.textContent = notice.status;
      time.dateTime = notice.createdAt;
      time.textContent = formatDate(notice.createdAt);
      details.textContent = notice.details;
      metadata.append(type, status, time);
      article.append(heading, metadata, details);
      elements.memberNoticeList.append(article);
    });
    return;
  }

  if (!notices.length) appendEmpty(elements.adminNoticeList, 'Issued warnings and violations will appear here.');
  notices.forEach((notice) => {
    const article = document.createElement('article');
    const heading = document.createElement('h4');
    const metadata = document.createElement('div');
    const time = document.createElement('time');
    const details = document.createElement('p');
    const action = document.createElement('button');
    article.className = `notice-item notice-${notice.type.toLowerCase()}`;
    heading.textContent = `${notice.type} · ${notice.memberName}`;
    metadata.className = 'notice-meta';
    time.dateTime = notice.createdAt;
    time.textContent = `${formatDate(notice.createdAt)} · ${notice.status}`;
    details.textContent = notice.details;
    action.type = 'button';
    action.className = 'task-remove';
    action.dataset.noticeId = notice.id;
    action.dataset.noticeStatus = notice.status;
    action.textContent = notice.status === 'Open' ? 'Resolve' : 'Reopen';
    metadata.append(time);
    article.append(heading, metadata, details, action);
    elements.adminNoticeList.append(article);
  });
}

function renderDashboard() {
  const user = state.user;
  const isAdmin = user.role === 'admin';
  elements.loginStage.classList.add('hidden');
  elements.dashboardStage.classList.remove('hidden');
  elements.greeting.textContent = `Welcome back, ${user.name}`;
  elements.dashboardRoleLabel.textContent = isAdmin ? 'Administrator account' : 'Member account';
  elements.codeDisplay.textContent = user.code || '';
  elements.codeDisplay.classList.toggle('hidden', isAdmin);
  elements.sidebarMemberName.textContent = user.name;
  elements.dashboardMemberName.textContent = user.name;
  elements.memberStatusValue.textContent = isAdmin ? 'Founder' : user.status;
  elements.memberAccessValue.textContent = isAdmin ? 'Administrator' : 'Member';
  elements.memberCodeValue.textContent = user.code || '';
  elements.memberCodeRow.classList.toggle('hidden', isAdmin);
  elements.memberVerification.textContent = isAdmin ? 'Founder access' : 'Verified XYS member';
  elements.memberIdentity.classList.toggle('hidden', isAdmin);
  elements.adminIdentity.classList.toggle('hidden', !isAdmin);
  elements.adminPanel.classList.toggle('hidden', !isAdmin);
  elements.adminNavLink.classList.toggle('hidden', !isAdmin);
  elements.noticesNavLink.classList.toggle('hidden', isAdmin);
  elements.taskPanel.classList.toggle('hidden', isAdmin);
  elements.activityPanel.classList.toggle('hidden', isAdmin);
  elements.checkinPanel.classList.toggle('hidden', isAdmin);
  elements.noticesPanel.classList.toggle('hidden', isAdmin);
  elements.pointsPanel.classList.toggle('hidden', isAdmin);
  elements.pointsCard.classList.toggle('hidden', isAdmin);
  elements.pointsNavLink.classList.toggle('hidden', isAdmin);
  elements.passwordPanel.classList.toggle('hidden', isAdmin);
  elements.eventsPanel.classList.remove('hidden');
  elements.lastCheckIn.textContent = user.lastCheckIn ? formatDate(user.lastCheckIn) : isAdmin ? 'Founder' : 'Not yet';
  elements.activityCount.textContent = String(state.activity.length);
  elements.pointsBalance.textContent = String(state.user.points || 0);
  renderTasks();
  renderTimeline(elements.activityList, state.activity, 'Your activity will appear here.', 'message');
  renderTimeline(elements.checkinHistory, state.checkins, 'Your check-ins will appear here.', 'note');
  renderTimeline(elements.adminActivityList, state.adminActivity || [], 'Founder actions will appear here.', 'message');
  renderAnnouncements();
  renderEvents();
  renderMembers();
  renderNotices();
  renderPoints();
}

function renderPoints() {
  const isAdmin = state.user.role === 'admin';
  const container = isAdmin ? elements.adminPointsHistory : elements.memberPointsHistory;
  const entries = state.pointHistory || [];
  container.replaceChildren();
  if (!entries.length) {
    appendEmpty(container, isAdmin ? 'Point adjustments will appear here.' : 'You have no point adjustments yet.');
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement('li');
    const summary = document.createElement('span');
    const time = document.createElement('time');
    const amount = `${entry.delta > 0 ? '+' : ''}${entry.delta} points`;
    item.className = 'timeline-item';
    summary.className = 'activity-label';
    summary.textContent = `${isAdmin ? `${entry.memberName}: ` : ''}${amount} · balance ${entry.balanceAfter} · ${entry.reason}`;
    time.className = 'activity-time';
    time.dateTime = entry.createdAt;
    time.textContent = formatDate(entry.createdAt);
    item.append(summary, time);
    container.append(item);
  });
}

function selectLoginMode(mode) {
  loginMode = mode;
  const isAdmin = mode === 'admin';
  elements.memberTab.classList.toggle('active', !isAdmin);
  elements.adminTab.classList.toggle('active', isAdmin);
  elements.memberTab.setAttribute('aria-pressed', String(!isAdmin));
  elements.adminTab.setAttribute('aria-pressed', String(isAdmin));
  elements.accessPasswordField.classList.toggle('hidden', isAdmin);
  elements.accessPassword.required = !isAdmin;
  elements.accessPassword.value = '';
  setMessage(elements.loginMessage, '');
}

elements.memberTab.addEventListener('click', () => selectLoginMode('member'));
elements.adminTab.addEventListener('click', () => selectLoginMode('admin'));

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(elements.loginMessage, 'Signing in…');
  try {
    const response = await api('/api/login', {
      method: 'POST',
      body: {
        code: normalizeCode(elements.accessCode.value),
        role: loginMode,
        ...(loginMode === 'member' ? { password: elements.accessPassword.value } : {})
      }
    });
    state = response.state;
    renderDashboard();
    elements.loginForm.reset();
  } catch (error) {
    setMessage(elements.loginMessage, error.message);
  }
});

elements.taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.taskInput.value.trim();
  try {
    await api('/api/tasks', { method: 'POST', body: { text } });
    elements.taskForm.reset();
    setMessage(elements.taskMessage, 'Task saved.');
    await refreshState();
  } catch (error) {
    setMessage(elements.taskMessage, error.message);
  }
});

elements.taskList.addEventListener('change', async (event) => {
  const taskId = event.target.dataset.taskId;
  if (!taskId) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: { done: event.target.checked } });
    await refreshState();
  } catch (error) {
    setMessage(elements.taskMessage, error.message);
    await refreshState();
  }
});

elements.taskList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-remove-task]');
  if (!button) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(button.dataset.removeTask)}`, { method: 'DELETE' });
    setMessage(elements.taskMessage, 'Task removed.');
    await refreshState();
  } catch (error) {
    setMessage(elements.taskMessage, error.message);
  }
});

elements.checkinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = elements.checkinNote.value.trim();
  try {
    await api('/api/checkins', { method: 'POST', body: { note } });
    elements.checkinForm.reset();
    setMessage(elements.checkinMessage, 'Check-in saved to your account.');
    await refreshState();
  } catch (error) {
    setMessage(elements.checkinMessage, error.message);
  }
});

elements.eventList.addEventListener('click', async (event) => {
  const removeButton = event.target.closest('button[data-delete-event]');
  const actionButton = event.target.closest('button[data-event-action]');
  try {
    if (removeButton) {
      await api(`/api/admin/events/${encodeURIComponent(removeButton.dataset.deleteEvent)}`, { method: 'DELETE' });
      setMessage(elements.eventMessage, 'Event removed.');
    } else if (actionButton) {
      const action = actionButton.dataset.eventAction === 'attendance' ? 'attendance' : 'rsvp';
      const response = await api(`/api/events/${encodeURIComponent(actionButton.dataset.eventId)}/${action}`, { method: 'POST', body: {} });
      setMessage(elements.eventMessage, action === 'attendance' ? 'Attendance confirmed and added to check-in history.' : response.rsvped ? 'You are on the RSVP list.' : 'Your RSVP was cancelled.');
    } else return;
    await refreshState();
  } catch (error) {
    setMessage(elements.eventMessage, error.message);
  }
});

elements.memberForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/members', {
      method: 'POST',
      body: {
        name: document.getElementById('newMemberName').value.trim(),
        code: normalizeCode(document.getElementById('newMemberCode').value),
        password: document.getElementById('newMemberPassword').value
      }
    });
    elements.memberForm.reset();
    setMessage(elements.adminMessage, 'Member added. Share the temporary password privately.');
    await refreshState();
  } catch (error) {
    setMessage(elements.adminMessage, error.message);
  }
});

elements.memberDirectory.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-member-code]');
  if (!button) return;
  const status = button.dataset.memberStatus === 'Active' ? 'Suspended' : 'Active';
  try {
    await api(`/api/admin/members/${encodeURIComponent(button.dataset.memberCode)}/status`, { method: 'PATCH', body: { status } });
    setMessage(elements.adminMessage, `Member ${status.toLowerCase()}.`);
    await refreshState();
  } catch (error) {
    setMessage(elements.adminMessage, error.message);
  }
});

elements.pointsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const memberCode = elements.pointsMember.value;
  const delta = Number(elements.pointsDelta.value);
  const reason = elements.pointsReason.value.trim();
  try {
    await api(`/api/admin/members/${encodeURIComponent(memberCode)}/points`, {
      method: 'POST',
      body: { delta, reason }
    });
    elements.pointsForm.reset();
    setMessage(elements.pointsMessage, 'Member point bank updated.');
    await refreshState();
  } catch (error) {
    setMessage(elements.pointsMessage, error.message);
  }
});

elements.recoverMemberForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/members/recover', {
      method: 'POST',
      body: {
        oldCode: normalizeCode(document.getElementById('recoveryCurrentCode').value),
        newCode: normalizeCode(document.getElementById('recoveryNewCode').value),
        password: document.getElementById('recoveryPassword').value
      }
    });
    elements.recoverMemberForm.reset();
    setMessage(elements.adminMessage, 'Account recovered. Share the replacement code and temporary password privately.');
    await refreshState();
  } catch (error) {
    setMessage(elements.adminMessage, error.message);
  }
});

elements.announcementForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/announcements', {
      method: 'POST',
      body: {
        title: document.getElementById('announcementTitle').value.trim(),
        body: document.getElementById('announcementBody').value.trim()
      }
    });
    elements.announcementForm.reset();
    setMessage(elements.adminMessage, 'Announcement published.');
    await refreshState();
  } catch (error) {
    setMessage(elements.adminMessage, error.message);
  }
});

elements.eventForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/events', {
      method: 'POST',
      body: {
        title: document.getElementById('eventTitle').value.trim(),
        startsAt: new Date(document.getElementById('eventDate').value).toISOString(),
        details: document.getElementById('eventDetails').value.trim()
      }
    });
    elements.eventForm.reset();
    setMessage(elements.adminMessage, 'Event added to the calendar.');
    await refreshState();
  } catch (error) {
    setMessage(elements.adminMessage, error.message);
  }
});

elements.disciplineForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/notices', {
      method: 'POST',
      body: {
        memberCode: elements.disciplineMember.value,
        type: elements.disciplineType.value,
        details: elements.disciplineDetails.value.trim()
      }
    });
    elements.disciplineForm.reset();
    setMessage(elements.disciplineMessage, 'Notice issued to the member record.');
    await refreshState();
  } catch (error) {
    setMessage(elements.disciplineMessage, error.message);
  }
});

elements.adminNoticeList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-notice-id]');
  if (!button) return;
  const status = button.dataset.noticeStatus === 'Open' ? 'Resolved' : 'Open';
  try {
    await api(`/api/admin/notices/${encodeURIComponent(button.dataset.noticeId)}`, { method: 'PATCH', body: { status } });
    setMessage(elements.disciplineMessage, `Notice marked ${status.toLowerCase()}.`);
    await refreshState();
  } catch (error) {
    setMessage(elements.disciplineMessage, error.message);
  }
});

elements.passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/password', {
      method: 'POST',
      body: {
        currentPassword: document.getElementById('currentPassword').value,
        newPassword: document.getElementById('newPassword').value
      }
    });
    elements.passwordForm.reset();
    setMessage(elements.passwordMessage, 'Password updated.');
  } catch (error) {
    setMessage(elements.passwordMessage, error.message);
  }
});

elements.exportBackupButton.addEventListener('click', async () => {
  try {
    const backup = await api('/api/admin/backup', { method: 'POST', body: {}, download: true });
    const link = document.createElement('a');
    const url = URL.createObjectURL(backup);
    link.href = url;
    link.download = `xys-portal-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(elements.backupMessage, 'Database backup downloaded.');
  } catch (error) {
    setMessage(elements.backupMessage, error.message);
  }
});

elements.logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } finally {
    state = null;
    elements.dashboardStage.classList.add('hidden');
    elements.loginStage.classList.remove('hidden');
    elements.loginForm.reset();
    selectLoginMode('member');
  }
});

document.querySelectorAll('.sidebar-nav a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-nav a').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  });
});

selectLoginMode('member');
api('/api/logout', { method: 'POST', body: {} }).catch(() => {});