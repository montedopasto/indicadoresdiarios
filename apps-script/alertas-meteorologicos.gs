/**
 * Alertas meteorológicos preventivos — Monte do Pasto
 * Google Apps Script
 *
 * Executar setupWeatherAlerts() uma vez para:
 *   1. autorizar o envio de email e o acesso à previsão;
 *   2. criar a verificação automática horária;
 *   3. receber um email de teste.
 */

const WEATHER_ALERT_CONFIG = Object.freeze({
  recipient: 'jose.almanso@montedopasto.pt',
  latitude: 38.219,
  longitude: -7.887,
  timezone: 'Europe/Lisbon',
  forecastHours: 72,
  clearChecksBeforeReset: 2,
  thresholds: Object.freeze({
    rain6h: [10, 20, 35],
    rain24h: [20, 40, 70],
    rain72h: [35, 70, 110],
    windGust: [45, 60, 80],
    heat: [35, 38, 42],
    cold: [2, 0, -2]
  })
});

const WEATHER_ALERT_STATE_KEY = 'MONTE_DO_PASTO_WEATHER_ALERT_STATE_V1';
const WEATHER_ALERT_HANDLER = 'checkWeatherAlerts';

function setupWeatherAlerts() {
  removeWeatherAlertTriggers_();
  ScriptApp.newTrigger(WEATHER_ALERT_HANDLER)
    .timeBased()
    .everyHours(1)
    .create();

  PropertiesService.getScriptProperties().deleteProperty(WEATHER_ALERT_STATE_KEY);
  sendWeatherAlertTest();
}

function checkWeatherAlerts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;

  try {
    const forecast = fetchWeatherForecast_();
    const risks = evaluateWeatherRisks_(forecast);
    const previousState = readWeatherAlertState_();
    const result = selectDeteriorations_(risks, previousState);

    if (result.alerts.length) {
      sendWeatherAlertEmail_(result.alerts, false);
    }

    writeWeatherAlertState_(result.nextState);
  } catch (error) {
    console.error('Falha na verificação meteorológica: ' + error.stack);
  } finally {
    lock.releaseLock();
  }
}

function sendWeatherAlertTest() {
  const testAlert = {
    type: 'test',
    level: 1,
    eventDay: Utilities.formatDate(new Date(), WEATHER_ALERT_CONFIG.timezone, 'yyyy-MM-dd'),
    title: 'Sistema de alertas preventivos ativo',
    summary: 'Este é um teste. Nenhuma condição meteorológica adversa foi detetada.',
    timing: 'Verificação automática de hora a hora',
    measures: [
      'O sistema permanecerá silencioso enquanto as condições forem estáveis.',
      'Um novo email será enviado apenas se surgir um risco ou se o risco se agravar.'
    ]
  };

  sendWeatherAlertEmail_([testAlert], true);
}

function removeWeatherAlertTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === WEATHER_ALERT_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function fetchWeatherForecast_() {
  const config = WEATHER_ALERT_CONFIG;
  const params = [
    'latitude=' + encodeURIComponent(config.latitude),
    'longitude=' + encodeURIComponent(config.longitude),
    'hourly=precipitation,precipitation_probability,weather_code,wind_gusts_10m',
    'daily=temperature_2m_max,temperature_2m_min,weather_code',
    'forecast_days=4',
    'timezone=' + encodeURIComponent(config.timezone)
  ];
  const url = 'https://api.open-meteo.com/v1/forecast?' + params.join('&');
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Accept: 'application/json' }
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('A previsão meteorológica respondeu com HTTP ' + response.getResponseCode());
  }

  const data = JSON.parse(response.getContentText());
  if (!data.hourly || !data.daily) {
    throw new Error('A previsão meteorológica não contém os dados esperados.');
  }
  return data;
}

function evaluateWeatherRisks_(forecast) {
  return [
    evaluateRainRisk_(forecast),
    evaluateWindRisk_(forecast),
    evaluateStormRisk_(forecast),
    evaluateHeatRisk_(forecast),
    evaluateColdRisk_(forecast)
  ];
}

function evaluateRainRisk_(forecast) {
  const hourly = forecast.hourly || {};
  const times = (hourly.time || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours);
  const rain = (hourly.precipitation || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours)
    .map(function(value) { return Number(value) || 0; });
  const chance = (hourly.precipitation_probability || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours)
    .map(function(value) { return Number(value) || 0; });

  const six = maxRollingSum_(rain, 6);
  const day = maxRollingSum_(rain, 24);
  const total = rain.reduce(function(sum, value) { return sum + value; }, 0);
  const thresholds = WEATHER_ALERT_CONFIG.thresholds;
  const level = Math.max(
    severityAbove_(six.value, thresholds.rain6h),
    severityAbove_(day.value, thresholds.rain24h),
    severityAbove_(total, thresholds.rain72h)
  );
  const peakIndex = indexOfMaximum_(rain);
  const maxChance = chance.length ? Math.max.apply(null, chance) : 0;

  return {
    type: 'rain',
    level: level,
    eventDay: eventDay_(times[peakIndex]),
    title: level >= 3 ? 'Chuva muito intensa prevista' : level === 2 ? 'Chuva forte prevista' : 'Chuva persistente prevista',
    summary: 'Até ' + formatNumber_(six.value) + ' L/m² em 6 h, ' + formatNumber_(day.value) +
      ' L/m² em 24 h e ' + formatNumber_(total) + ' L/m² nas próximas 72 h. Probabilidade máxima: ' +
      Math.round(maxChance) + '%.',
    timing: formatForecastTime_(times[peakIndex]),
    measures: [
      'Verificar e desobstruir valas, caleiras, sumidouros e pontos de drenagem.',
      'Confirmar o estado dos acessos, pisos e zonas baixas com maior acumulação de água.',
      'Proteger materiais e equipamento colocados no exterior.',
      'Confirmar a disponibilidade de bombas e outros meios de escoamento.'
    ]
  };
}

function evaluateWindRisk_(forecast) {
  const hourly = forecast.hourly || {};
  const times = (hourly.time || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours);
  const gusts = (hourly.wind_gusts_10m || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours)
    .map(function(value) { return Number(value) || 0; });
  const peakIndex = indexOfMaximum_(gusts);
  const peak = peakIndex >= 0 ? gusts[peakIndex] : 0;
  const level = severityAbove_(peak, WEATHER_ALERT_CONFIG.thresholds.windGust);

  return {
    type: 'wind',
    level: level,
    eventDay: eventDay_(times[peakIndex]),
    title: level >= 3 ? 'Rajadas muito fortes previstas' : level === 2 ? 'Rajadas fortes previstas' : 'Aumento significativo do vento',
    summary: 'Rajada máxima prevista de ' + Math.round(peak) + ' km/h nas próximas 72 horas.',
    timing: formatForecastTime_(times[peakIndex]),
    measures: [
      'Fixar ou recolher materiais leves e objetos soltos no exterior.',
      'Verificar coberturas, portões, vedações e estruturas expostas.',
      'Proteger equipamento sensível e confirmar portas e acessos técnicos.',
      'Reforçar a atenção a ramos, chapas e outros elementos vulneráveis.'
    ]
  };
}

function evaluateStormRisk_(forecast) {
  const hourly = forecast.hourly || {};
  const times = (hourly.time || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours);
  const codes = (hourly.weather_code || []).slice(0, WEATHER_ALERT_CONFIG.forecastHours)
    .map(function(value) { return Number(value) || 0; });
  let level = 0;
  let eventIndex = -1;

  codes.forEach(function(code, index) {
    const codeLevel = code === 96 || code === 99 ? 3 : code === 95 ? 2 : 0;
    if (codeLevel > level) {
      level = codeLevel;
      eventIndex = index;
    }
  });

  return {
    type: 'storm',
    level: level,
    eventDay: eventDay_(times[eventIndex]),
    title: level >= 3 ? 'Trovoada com possibilidade de granizo' : 'Trovoada prevista',
    summary: level >= 3 ? 'A previsão indica trovoada com possibilidade de granizo.' : 'A previsão indica ocorrência de trovoada.',
    timing: formatForecastTime_(times[eventIndex]),
    measures: [
      'Proteger equipamentos elétricos e materiais vulneráveis no exterior.',
      'Verificar coberturas, caleiras e pontos de escoamento.',
      'Confirmar os sistemas de alimentação elétrica de apoio.',
      'Manter os acessos técnicos desimpedidos para resposta rápida.'
    ]
  };
}

function evaluateHeatRisk_(forecast) {
  const daily = forecast.daily || {};
  const times = (daily.time || []).slice(0, 4);
  const values = (daily.temperature_2m_max || []).slice(0, 4)
    .map(function(value) { return Number(value); });
  const peakIndex = indexOfMaximum_(values);
  const peak = peakIndex >= 0 ? values[peakIndex] : 0;
  const level = severityAbove_(peak, WEATHER_ALERT_CONFIG.thresholds.heat);

  return {
    type: 'heat',
    level: level,
    eventDay: eventDay_(times[peakIndex]),
    title: level >= 3 ? 'Calor extremo previsto' : level === 2 ? 'Calor muito intenso previsto' : 'Subida acentuada da temperatura',
    summary: 'Temperatura máxima prevista de ' + formatNumber_(peak) + ' °C.',
    timing: formatForecastDay_(times[peakIndex]),
    measures: [
      'Reforçar a vigilância de vegetação seca e pontos com risco de ignição.',
      'Confirmar a disponibilidade de água e meios de primeira intervenção.',
      'Afastar materiais combustíveis de equipamentos e zonas técnicas.',
      'Verificar mangueiras, depósitos e acessos utilizados numa resposta rápida.'
    ]
  };
}

function evaluateColdRisk_(forecast) {
  const daily = forecast.daily || {};
  const times = (daily.time || []).slice(0, 4);
  const values = (daily.temperature_2m_min || []).slice(0, 4)
    .map(function(value) { return Number(value); });
  const peakIndex = indexOfMinimum_(values);
  const peak = peakIndex >= 0 ? values[peakIndex] : 99;
  const level = severityBelow_(peak, WEATHER_ALERT_CONFIG.thresholds.cold);

  return {
    type: 'cold',
    level: level,
    eventDay: eventDay_(times[peakIndex]),
    title: level >= 3 ? 'Geada intensa prevista' : level === 2 ? 'Geada provável' : 'Descida acentuada da temperatura',
    summary: 'Temperatura mínima prevista de ' + formatNumber_(peak) + ' °C.',
    timing: formatForecastDay_(times[peakIndex]),
    measures: [
      'Proteger tubagens, torneiras, bombas e equipamentos expostos.',
      'Confirmar isolamento e funcionamento de sistemas sensíveis ao frio.',
      'Verificar antecipadamente pontos onde possa ocorrer gelo.',
      'Manter materiais de proteção acessíveis para utilização preventiva.'
    ]
  };
}

function selectDeteriorations_(risks, previousState) {
  const alerts = [];
  const nextState = Object.assign({}, previousState);

  risks.forEach(function(risk) {
    const previous = previousState[risk.type] || { level: 0, eventDay: '', clearChecks: 0 };

    if (risk.level <= 0) {
      const clearChecks = (Number(previous.clearChecks) || 0) + 1;
      nextState[risk.type] = clearChecks >= WEATHER_ALERT_CONFIG.clearChecksBeforeReset
        ? { level: 0, eventDay: '', clearChecks: clearChecks }
        : { level: previous.level || 0, eventDay: previous.eventDay || '', clearChecks: clearChecks };
      return;
    }

    const isNewEvent = previous.level === 0;
    const isWorse = risk.level > (Number(previous.level) || 0);
    if (isNewEvent || isWorse) alerts.push(risk);

    nextState[risk.type] = {
      level: Math.max(risk.level, Number(previous.level) || 0),
      eventDay: risk.eventDay || previous.eventDay || '',
      clearChecks: 0
    };
  });

  return { alerts: alerts, nextState: nextState };
}

function sendWeatherAlertEmail_(alerts, isTest) {
  const highest = alerts.reduce(function(max, alert) { return Math.max(max, alert.level || 0); }, 0);
  const subject = isTest
    ? '[TESTE] Alertas meteorológicos preventivos — Monte do Pasto'
    : '[ALERTA PREVENTIVO] ' + (alerts.length === 1 ? alerts[0].title : 'Condições climatéricas adversas previstas');
  const color = highest >= 3 ? '#c9483f' : highest === 2 ? '#d4932f' : '#d4b35d';
  const generatedAt = Utilities.formatDate(new Date(), WEATHER_ALERT_CONFIG.timezone, "dd/MM/yyyy 'às' HH:mm");

  const cards = alerts.map(function(alert) {
    const measures = alert.measures.map(function(measure) {
      return '<li style="margin:0 0 6px">' + htmlEscape_(measure) + '</li>';
    }).join('');
    return '<div style="margin:0 0 18px;padding:18px;border:1px solid #d9e2dc;border-left:6px solid ' + color + ';border-radius:10px;background:#f7faf8">' +
      '<h2 style="margin:0 0 8px;color:#123b2a;font-size:20px">' + htmlEscape_(alert.title) + '</h2>' +
      '<p style="margin:0 0 6px;color:#31493f"><strong>Quando:</strong> ' + htmlEscape_(alert.timing) + '</p>' +
      '<p style="margin:0 0 12px;color:#31493f">' + htmlEscape_(alert.summary) + '</p>' +
      '<p style="margin:0 0 7px;color:#123b2a"><strong>Preparação recomendada</strong></p>' +
      '<ul style="margin:0;padding-left:20px;color:#31493f">' + measures + '</ul>' +
      '</div>';
  }).join('');

  const html = '<div style="font-family:Arial,sans-serif;max-width:720px;margin:auto;color:#20362d">' +
    '<div style="padding:20px 22px;background:#123b2a;color:white;border-radius:12px 12px 0 0">' +
    '<div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:#e2c46d">Monte do Pasto</div>' +
    '<h1 style="margin:6px 0 0;font-size:24px">Alerta meteorológico preventivo</h1></div>' +
    '<div style="padding:22px;background:white;border:1px solid #d9e2dc;border-top:0">' +
    (isTest ? '<p style="margin:0 0 18px"><strong>Mensagem de teste:</strong> o envio automático ficou preparado.</p>' :
      '<p style="margin:0 0 18px">A previsão indica uma deterioração das condições climatéricas. Antecipar as medidas abaixo para preparar a exploração.</p>') +
    cards +
    '<p style="margin:18px 0 0;color:#6a7c73;font-size:12px">Análise automática gerada em ' + htmlEscape_(generatedAt) +
    '. Confirmar a evolução da previsão e adaptar as medidas às condições observadas no local.</p></div></div>';

  const plain = alerts.map(function(alert) {
    return alert.title + '\nQuando: ' + alert.timing + '\n' + alert.summary + '\n- ' + alert.measures.join('\n- ');
  }).join('\n\n');

  MailApp.sendEmail({
    to: WEATHER_ALERT_CONFIG.recipient,
    subject: subject,
    body: plain,
    htmlBody: html,
    name: 'Monte do Pasto · Alertas Preventivos'
  });
}

function readWeatherAlertState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(WEATHER_ALERT_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeWeatherAlertState_(state) {
  PropertiesService.getScriptProperties().setProperty(WEATHER_ALERT_STATE_KEY, JSON.stringify(state));
}

function severityAbove_(value, thresholds) {
  if (!Number.isFinite(value)) return 0;
  if (value >= thresholds[2]) return 3;
  if (value >= thresholds[1]) return 2;
  if (value >= thresholds[0]) return 1;
  return 0;
}

function severityBelow_(value, thresholds) {
  if (!Number.isFinite(value)) return 0;
  if (value <= thresholds[2]) return 3;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[0]) return 1;
  return 0;
}

function maxRollingSum_(values, size) {
  if (!values.length) return { value: 0, index: -1 };
  let running = 0;
  let best = -Infinity;
  let bestIndex = 0;
  values.forEach(function(value, index) {
    running += Number(value) || 0;
    if (index >= size) running -= Number(values[index - size]) || 0;
    if (running > best) {
      best = running;
      bestIndex = Math.max(0, index - size + 1);
    }
  });
  return { value: Math.max(0, best), index: bestIndex };
}

function indexOfMaximum_(values) {
  if (!values.length) return -1;
  return values.reduce(function(best, value, index, array) {
    return Number(value) > Number(array[best]) ? index : best;
  }, 0);
}

function indexOfMinimum_(values) {
  if (!values.length) return -1;
  return values.reduce(function(best, value, index, array) {
    return Number(value) < Number(array[best]) ? index : best;
  }, 0);
}

function eventDay_(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value).slice(0, 10);
  return Utilities.formatDate(date, WEATHER_ALERT_CONFIG.timezone, 'yyyy-MM-dd');
}

function formatForecastTime_(value) {
  if (!value) return 'nas próximas 72 horas';
  const date = new Date(value);
  if (isNaN(date.getTime())) return 'nas próximas 72 horas';
  return Utilities.formatDate(date, WEATHER_ALERT_CONFIG.timezone, "EEEE, dd/MM, 'cerca das' HH:mm");
}

function formatForecastDay_(value) {
  if (!value) return 'nos próximos dias';
  const date = new Date(value + 'T12:00:00');
  if (isNaN(date.getTime())) return 'nos próximos dias';
  return Utilities.formatDate(date, WEATHER_ALERT_CONFIG.timezone, 'EEEE, dd/MM');
}

function formatNumber_(value) {
  return (Number(value) || 0).toFixed(1).replace('.', ',');
}

function htmlEscape_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
