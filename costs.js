const $ = selector => document.querySelector(selector);
const api = url => fetch(url).then(async response => {
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed');
  return data;
});
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

api('/api/state').then(state => {
  const costs = state.costs;
  const focused = new URLSearchParams(location.search).get('team');
  const selectedTeam = state.organizations.find(team => team.id === focused);
  const reportTeams = selectedTeam ? costs.teams.filter(cost => cost.organizationId === focused) : costs.teams;

  if (selectedTeam) {
    const back = $('.back');
    back.href = '/team.html?team=' + encodeURIComponent(selectedTeam.id) + '#costs';
    back.textContent = '← ' + selectedTeam.name + ' workspace';
  }

  $('#period').textContent = (selectedTeam ? selectedTeam.name + ' · ' : '') + costs.period;
  $('header h1').textContent = selectedTeam ? selectedTeam.name + ' cost & utilization' : 'Cost & utilization report';
  $('.panel-heading h2').textContent = selectedTeam ? 'Team chargeback statement' : 'Monthly chargeback statement';
  $('#allocation').innerHTML = '<article><small>SHARED PLATFORM POOL</small><b>' + money(costs.sharedPlatformCost) + '</b><span>Allocated by each team’s governed execution volume.</span></article><article><small>ALLOCATION RULE</small><b>Usage-based</b><span>Execution share determines each team’s platform allocation.</span></article><article><small>CHARGEBACK MODEL</small><b>Direct + shared</b><span>Model, tools, infrastructure, and platform services are visible separately.</span></article>';
  $('#chargeTable').innerHTML = '<div class="table-head"><span>TEAM</span><span>DIRECT USAGE</span><span>SHARED ALLOCATION</span><span>TOTAL SPEND</span><span>BUDGET</span><span>FORECAST</span></div>' + reportTeams.map(cost => {
    const team = state.organizations.find(org => org.id === cost.organizationId);
    return '<a class="table-row focused" href="/team.html?team=' + encodeURIComponent(cost.organizationId) + '#costs"><span><b>' + team.name + '</b><small>' + cost.executions.toLocaleString() + ' governed executions</small></span><span>' + money(cost.directCost) + '</span><span>' + money(cost.sharedAllocation) + '</span><span><b>' + money(cost.totalCost) + '</b></span><span>' + money(cost.budget) + '<small class="' + (cost.budgetRemaining < 0 ? 'over' : '') + '">' + money(cost.budgetRemaining) + ' remaining</small></span><span>' + money(cost.forecast) + '</span></a>';
  }).join('');
}).catch(error => {
  document.body.innerHTML = '<main><h1>Unable to load chargeback report</h1><p>' + error.message + '</p></main>';
});
