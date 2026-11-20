'use strict';
const { t, getLanguage } = require('./i18n');
// "left" in an interval means remaining, not the direction of the controller.
function serviceIntervalText(value) {
    const text = String(value == null ? '' : value);
    if (getLanguage() !== 'zh-CN') return text;
    if (text.indexOf('; ') >= 0) return text.split('; ').map(serviceIntervalText).join('；');
    if (text === 'left') return t('Service interval remaining');
    if (text === 'overdue') return t('Service interval overdue');
    const match = /^(.*?) (left|over)$/.exec(text);
    if (match) return t(match[2] === 'left' ? 'Service interval remaining' : 'Service interval overdue') + ' ' + t(match[1]);
    return t(text);
}
module.exports = { serviceIntervalText };
