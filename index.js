require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const cron = require('node-cron');

const TIMEZONE = 'Asia/Samarkand';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN .env faylda topilmadi!');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

function normalizeId(id) {
  if (!id) return '';
  return String(id).trim();
}

const ADMIN_ID = normalizeId(process.env.ADMIN_ID);
const CHANNEL_ID = normalizeId(process.env.CHANNEL_ID);
const GROUP_ID = normalizeId(process.env.GROUP_ID);
const ADMIN_GROUP_ID = normalizeId(process.env.ADMIN_GROUP_ID);

console.log('Konfiguratsiya:');
console.log('ADMIN_ID:', ADMIN_ID);
console.log('CHANNEL_ID:', CHANNEL_ID);
console.log('GROUP_ID:', GROUP_ID);
console.log('ADMIN_GROUP_ID:', ADMIN_GROUP_ID);

const userStates = new Map();
const userData = new Map();
const workSessions = new Map();
const userMessageCount = new Map();

const DATA_DIR = path.join(__dirname, 'data');
const USER_DATA_FILE = path.join(DATA_DIR, 'users.json');
const WORK_SESSIONS_FILE = path.join(DATA_DIR, 'work_sessions.json');
const ARCHIVED_SESSIONS_FILE = path.join(DATA_DIR, 'archived_sessions.json');
const EXCEL_FILE = path.join(DATA_DIR, 'data.xlsx');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDate() {
  return DateTime.now().setZone(TIMEZONE).toFormat('yyyy-MM-dd');
}

function getTime() {
  return DateTime.now().setZone(TIMEZONE).toFormat('HH:mm:ss');
}

function getDateTime() {
  return DateTime.now().setZone(TIMEZONE).toJSDate();
}

function getFormattedDateTime() {
  return DateTime.now().setZone(TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss');
}

function formatDuration(startDate, endDate) {
  const start = DateTime.fromJSDate(startDate);
  const end = DateTime.fromJSDate(endDate);
  const diff = end.diff(start, ['hours', 'minutes']).toObject();
  return `${Math.floor(diff.hours)} soat ${Math.floor(diff.minutes)} daqiqa`;
}

function getCellValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) {
    return '';
  }

  const value = cell.value;

  if (typeof value === 'object' && value.hyperlink) {
    return value.hyperlink;
  }

  if (typeof value === 'object' && value.text !== undefined) {
    return String(value.text);
  }

  if (typeof value === 'object' && value.result !== undefined) {
    return String(value.result);
  }

  if (value instanceof Date) {
    return DateTime.fromJSDate(value).setZone(TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss');
  }

  return String(value).trim();
}

function loadPersistedData() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
      Object.entries(data).forEach(([userId, user]) => {
        const userIdString = normalizeId(userId);
        userData.set(userIdString, user);
      });
      console.log(`${userData.size} ta foydalanuvchi ma'lumoti yuklandi`);
    }

    if (fs.existsSync(WORK_SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(WORK_SESSIONS_FILE, 'utf8'));
      Object.entries(data).forEach(([userId, session]) => {
        if (session.startDateTime) {
          session.startDateTime = new Date(session.startDateTime);
        }
        if (session.endDateTime) {
          session.endDateTime = new Date(session.endDateTime);
        }
        if (!session.otherExpenses) {
          session.otherExpenses = [];
        }
        const userIdString = normalizeId(userId);
        workSessions.set(userIdString, session);
      });
      console.log(`${workSessions.size} ta ochiq ish sessiyasi yuklandi`);
    }

    if (!fs.existsSync(ARCHIVED_SESSIONS_FILE)) {
      fs.writeFileSync(ARCHIVED_SESSIONS_FILE, JSON.stringify([]), 'utf8');
      console.log('Arxiv fayli yaratildi');
    }
  } catch (error) {
    console.error('Ma\'lumotlarni yuklashda xatolik:', error);
  }
}

function saveUserData() {
  try {
    const data = {};
    userData.forEach((user, userId) => {
      const userIdString = normalizeId(userId);
      data[userIdString] = user;
    });
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Foydalanuvchi ma\'lumotlarini saqlashda xatolik:', error);
  }
}

function saveWorkSessions() {
  try {
    const data = {};
    workSessions.forEach((session, userId) => {
      const userIdString = normalizeId(userId);
      data[userIdString] = session;
    });
    fs.writeFileSync(WORK_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Ish sessiyalarini saqlashda xatolik:', error);
  }
}

function appendToArchivedSessions(sessionData) {
  try {
    let archived = [];
    if (fs.existsSync(ARCHIVED_SESSIONS_FILE)) {
      const content = fs.readFileSync(ARCHIVED_SESSIONS_FILE, 'utf8');
      archived = content ? JSON.parse(content) : [];
    }
    archived.push(sessionData);
    fs.writeFileSync(ARCHIVED_SESSIONS_FILE, JSON.stringify(archived, null, 2), 'utf8');
    console.log(`Sessiya arxivga qo'shildi: ${sessionData.telegramId} - ${sessionData.date} ${sessionData.startTime}`);
    return true;
  } catch (error) {
    console.error('Arxivga yozishda xatolik:', error);
    return false;
  }
}

function getOrCreateSession(userId) {
  const userIdString = normalizeId(userId);
  let session = workSessions.get(userIdString);

  if (!session || session.endTime) {
    const user = userData.get(userIdString);
    session = {
      object: user?.currentObject || '',
      date: getDate(),
      startTime: getTime(),
      startDateTime: getDateTime(),
      startLocation: '',
      endLocation: '',
      endTime: '',
      endDateTime: null,
      avans: 0,
      taxiExpense: 0,
      foodExpense: 0,
      otherExpense: 0,
      otherExpenses: [],
      comments: [],
      hasVideo: false
    };
    workSessions.set(userIdString, session);
    saveWorkSessions();
    console.log(`Avtomatik sessiya yaratildi: ${user?.name || 'Noma\'lum'} (ID: ${userIdString}) at ${session.startTime}`);
  }

  if (!session.otherExpenses) {
    session.otherExpenses = [];
  }

  return session;
}

loadPersistedData();

const workSessionColumns = [
  { header: '№', key: 'rowNum', width: 5 },
  { header: 'Telegram Username', key: 'username', width: 30 },
  { header: 'Telegram ID', key: 'telegramId', width: 25 },
  { header: 'Ism familiya', key: 'name', width: 30 },
  { header: 'Telefon', key: 'phone', width: 25 },
  { header: 'Obyekt', key: 'object', width: 25 },
  { header: 'Sana', key: 'date', width: 20 },
  { header: 'Boshlanish', key: 'startTime', width: 20 },
  { header: 'Tugash', key: 'endTime', width: 20 },
  { header: 'Davomiyligi', key: 'duration', width: 20 },
  { header: 'Boshlanish lokatsiyasi', key: 'startLocation', width: 35 },
  { header: 'Tugash lokatsiyasi', key: 'endLocation', width: 35 },
  { header: 'Avans', key: 'avans', width: 15 },
  { header: 'Taksi', key: 'taxiExpense', width: 15 },
  { header: 'Ovqat', key: 'foodExpense', width: 15 },
  { header: 'Boshqa nomi', key: 'otherExpenseName', width: 20 },
  { header: 'Boshqa summasi', key: 'otherExpenseAmount', width: 15 },
  { header: 'Jami xarajat', key: 'totalExpense', width: 15 },
  { header: 'Diplom', key: 'hasDiploma', width: 15 },
  { header: 'Video', key: 'hasVideo', width: 15 },
  { header: 'Izoh', key: 'comments', width: 30 },
];

async function generateUsersPersonalDataReport(fromDate = null, toDate = null) {
  try {
    console.log('Ishchilar shaxsiy ma\'lumotlarini yig\'ish boshlandi...');

    if (!fs.existsSync(USER_DATA_FILE)) {
      console.log(`users.json fayli topilmadi: ${USER_DATA_FILE}`);
      return null;
    }

    if (!fs.existsSync(ARCHIVED_SESSIONS_FILE)) {
      console.log('Arxiv fayli topilmadi');
      return null;
    }

    const usersData = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
    const content = fs.readFileSync(ARCHIVED_SESSIONS_FILE, 'utf8');
    const archivedSessions = content ? JSON.parse(content) : [];

    console.log(`Jami arxivlangan sessiyalar: ${archivedSessions.length}`);

    const today = getDate();
    const useToday = !fromDate && !toDate;

    const filteredSessions = archivedSessions.filter(session => {
      if (!session || !session.date) return false;

      if (useToday) {
        return session.date === today;
      } else if (fromDate && toDate) {
        return session.date >= fromDate && session.date <= toDate;
      }
      return false;
    });

    console.log(`Filtrlangan sessiyalar: ${filteredSessions.length}`);

    if (filteredSessions.length === 0) {
      console.log('Hech qanday sessiya topilmadi');
      return null;
    }

    const dateStamp = fromDate && toDate ? `${fromDate}__${toDate}` : today;
    const reportPath = path.join(DATA_DIR, `ishchilar_malumotlari_${dateStamp}_${Date.now()}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ishchilar ma\'lumotlari');

    worksheet.columns = workSessionColumns;

    worksheet.getRow(1).font = { bold: true, size: 11 };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font.color = { argb: 'FFFFFFFF' };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 22;

    let globalRowNum = 1;

    for (const session of filteredSessions) {
      try {
        const telegramIdNormalized = normalizeId(session.telegramId);
        const user = usersData[telegramIdNormalized];

        if (!user) {
          console.log(`Foydalanuvchi topilmadi ID: ${telegramIdNormalized}`);
          continue;
        }

        const otherExpenseName = session.otherExpenses && session.otherExpenses.length > 0
          ? session.otherExpenses.map(e => e.name).join(', ')
          : '';
        const otherExpenseAmount = session.otherExpenses && session.otherExpenses.length > 0
          ? session.otherExpenses.reduce((sum, e) => sum + (e.amount || 0), 0)
          : 0;

        const rowData = {
          rowNum: globalRowNum,
          username: session.username || (user.username ? `@${user.username}` : ''),
          telegramId: telegramIdNormalized,
          name: session.name || user.name || '',
          phone: session.phone || user.phone || '',
          object: session.object || '',
          date: session.date || '',
          startTime: session.startTime || '',
          endTime: session.endTime || '',
          duration: session.duration || '',
          startLocation: session.startLocation || '',
          endLocation: session.endLocation || '',
          avans: session.avans || 0,
          taxiExpense: session.taxiExpense || 0,
          foodExpense: session.foodExpense || 0,
          otherExpenseName: otherExpenseName,
          otherExpenseAmount: otherExpenseAmount,
          totalExpense: session.totalExpense || 0,
          hasDiploma: session.hasDiploma || (user.hasDiploma ? 'Mavjud' : 'Mavjud emas'),
          hasVideo: session.hasVideo || '',
          comments: session.comments || ''
        };

        const newRow = worksheet.addRow(rowData);
        newRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        newRow.height = 25;

        console.log(`Qator ${globalRowNum}: ${rowData.name} - ${rowData.date} - ${rowData.object}`);
        globalRowNum++;
      } catch (error) {
        console.error(`Sessiyani qo'shishda xatolik:`, error.message);
      }
    }

    if (globalRowNum === 1) {
      console.log('Hech qanday qator qo\'shilmadi');
      return null;
    }

    await workbook.xlsx.writeFile(reportPath);
    console.log(`JAMI ${globalRowNum - 1} ta qator Excel faylga yozildi`);
    console.log(`Fayl saqlandi: ${reportPath}`);

    return reportPath;
  } catch (error) {
    console.error('Ishchilar ma\'lumotini yaratishda kritik xatolik:', error);
    throw error;
  }
}

async function saveWorkSession(sessionData) {
  try {
    const workbook = new ExcelJS.Workbook();
    let worksheet;

    if (fs.existsSync(EXCEL_FILE)) {
      await workbook.xlsx.readFile(EXCEL_FILE);
      worksheet = workbook.getWorksheet("Ish hisoboti");

      if (!worksheet) {
        worksheet = workbook.addWorksheet("Ish hisoboti");
        worksheet.columns = workSessionColumns;

        worksheet.getRow(1).font = { bold: true, size: 11 };
        worksheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF4472C4' }
        };
        worksheet.getRow(1).font.color = { argb: 'FFFFFFFF' };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        worksheet.getRow(1).height = 22;
      }
    } else {
      worksheet = workbook.addWorksheet("Ish hisoboti");
      worksheet.columns = workSessionColumns;

      worksheet.getRow(1).font = { bold: true, size: 11 };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      worksheet.getRow(1).font.color = { argb: 'FFFFFFFF' };
      worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
      worksheet.getRow(1).height = 22;
    }

    let lastRowNum = 0;
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const rowNumValue = getCellValue(row.getCell(1));
        const numValue = parseInt(rowNumValue);
        if (!isNaN(numValue) && numValue > lastRowNum) {
          lastRowNum = numValue;
        }
      }
    });

    const newRowNum = lastRowNum + 1;

    const telegramIdString = normalizeId(sessionData.telegramId);

    const rowData = {
      rowNum: newRowNum,
      username: sessionData.username ? `@${sessionData.username}` : '',
      telegramId: telegramIdString,
      name: sessionData.name || '',
      phone: sessionData.phone || '',
      object: sessionData.object || '',
      date: sessionData.date || '',
      startTime: sessionData.startTime || '',
      endTime: sessionData.endTime || '',
      duration: sessionData.duration || '',
      startLocation: sessionData.startLocation || '',
      endLocation: sessionData.endLocation || '',
      avans: sessionData.avans || 0,
      taxiExpense: sessionData.taxiExpense || 0,
      foodExpense: sessionData.foodExpense || 0,
      otherExpenseName: sessionData.otherExpenseName || '',
      otherExpenseAmount: sessionData.otherExpenseAmount || 0,
      totalExpense: sessionData.totalExpense || 0,
      hasDiploma: sessionData.hasDiploma || '',
      hasVideo: sessionData.hasVideo || '',
      comments: sessionData.comments || ''
    };

    const newRow = worksheet.addRow(rowData);
    newRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    newRow.height = 25;

    await workbook.xlsx.writeFile(EXCEL_FILE);

    console.log(`Qator ${newRowNum}: ${rowData.name || 'Noma\'lum'} - Obyekt: ${rowData.object || 'N/A'} - Telefon: ${rowData.phone} - ID: ${rowData.telegramId}`);
    return true;
  } catch (error) {
    console.error('Excelga yozishda xatolik:', error);
    return false;
  }
}

async function finalizeWorkSession(userId) {
  const userIdString = normalizeId(userId);
  const session = workSessions.get(userIdString);
  if (!session) {
    console.log(`Sessiya topilmadi: userId=${userId}`);
    return false;
  }

  const user = userData.get(userIdString);
  if (!user) {
    console.log(`Foydalanuvchi topilmadi: userId=${userId}`);
    return false;
  }

  const otherExpensesTotal = session.otherExpenses && session.otherExpenses.length > 0
    ? session.otherExpenses.reduce((sum, e) => sum + (e.amount || 0), 0)
    : 0;

  const totalExpense = (session.avans || 0) + (session.taxiExpense || 0) + (session.foodExpense || 0) + otherExpensesTotal;

  let duration = '';
  if (session.startDateTime && session.endDateTime) {
    duration = formatDuration(session.startDateTime, session.endDateTime);
  }

  const comments = session.comments && session.comments.length > 0 ? session.comments.join(' | ') : '';

  const otherExpenseName = session.otherExpenses && session.otherExpenses.length > 0
    ? session.otherExpenses.map(e => e.name).join(', ')
    : '';

  const sessionData = {
    username: user.username || '',
    telegramId: userIdString,
    name: user.name || '',
    phone: user.phone || '',
    object: session.object || '',
    date: session.date || '',
    startTime: session.startTime || '',
    endTime: session.endTime || '',
    duration: duration,
    startLocation: session.startLocation || '',
    endLocation: session.endLocation || '',
    avans: session.avans || 0,
    taxiExpense: session.taxiExpense || 0,
    foodExpense: session.foodExpense || 0,
    otherExpenses: session.otherExpenses || [],
    otherExpenseName: otherExpenseName,
    otherExpenseAmount: otherExpensesTotal,
    totalExpense: totalExpense || 0,
    hasDiploma: user.hasDiploma ? 'Mavjud' : 'Mavjud emas',
    hasVideo: session.hasVideo ? 'Ha' : "Yo'q",
    comments: comments
  };

  console.log(`Ishchi ma'lumotlarini saqlash: ${user.name} (ID: ${userIdString})`);

  const savedToExcel = await saveWorkSession(sessionData);
  const savedToArchive = appendToArchivedSessions(sessionData);

  if (savedToExcel && savedToArchive) {
    workSessions.delete(userIdString);
    saveWorkSessions();
    console.log(`Sessiya muvaffaqiyatli yakunlandi va arxivlandi: ${user.name}`);
  } else {
    console.log(`Sessiyani saqlashda xatolik: ${user.name}`);
  }

  return savedToExcel && savedToArchive;
}

async function sendAdminNotification(message, photoFileId = null, videoNoteFileId = null, location = null) {
  if (!ADMIN_ID) {
    console.log('ADMIN_ID mavjud emas');
    return;
  }

  try {
    const stickerFileIds = [
      'CAACAgIAAxkBAAEBBqZnbmZ0AAHMWvN3zFvO8P5c0bGP-AACOQADwDZPE_lqX5qCa011NgQ',
      'CAACAgIAAxkBAAEBBqhnbmZ2SQABxmPNH0qcpLzOHWZDJvAAAjkAA8A2TxP5al-agmtNdTYE'
    ];
    const randomSticker = stickerFileIds[Math.floor(Math.random() * stickerFileIds.length)];

    try {
      await bot.telegram.sendSticker(ADMIN_ID, randomSticker);
    } catch (e) {
      console.log('Stiker yuborilmadi, davom etamiz...');
    }

    if (photoFileId) {
      await bot.telegram.sendPhoto(ADMIN_ID, photoFileId, { caption: message });
    } else if (videoNoteFileId) {
      await bot.telegram.sendVideoNote(ADMIN_ID, videoNoteFileId);
      await bot.telegram.sendMessage(ADMIN_ID, message);
    } else if (location) {
      await bot.telegram.sendMessage(ADMIN_ID, message);
      await bot.telegram.sendLocation(ADMIN_ID, location.latitude, location.longitude);
    } else {
      await bot.telegram.sendMessage(ADMIN_ID, message);
    }
    console.log('Admin ga xabar yuborildi');
  } catch (e) {
    console.error('Admin ga xabar yuborishda xatolik:', e.message);
  }
}

async function sendGroupNotification(message, photoFileId = null, videoNoteFileId = null, location = null) {
  const targetGroupId = ADMIN_GROUP_ID || GROUP_ID;

  if (!targetGroupId) {
    console.log('ADMIN_GROUP_ID yoki GROUP_ID mavjud emas');
    return;
  }

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(targetGroupId, photoFileId, { caption: message });
    } else if (videoNoteFileId) {
      await bot.telegram.sendVideoNote(targetGroupId, videoNoteFileId);
      await bot.telegram.sendMessage(targetGroupId, message);
    } else if (location) {
      await bot.telegram.sendMessage(targetGroupId, message);
      await bot.telegram.sendLocation(targetGroupId, location.latitude, location.longitude);
    } else {
      await bot.telegram.sendMessage(targetGroupId, message);
    }
    console.log('Gruppaga xabar yuborildi');
  } catch (e) {
    console.error('Gruppaga xabar yuborishda xatolik:', e.message);
  }
}

async function generateAllUsersReport() {
  try {
    const reportPath = path.join(DATA_DIR, `barcha_ishchilar_royhati_${Date.now()}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Barcha ishchilar ro\'yxati');

    worksheet.columns = [
      { header: '№', key: 'rowNum', width: 5 },
      { header: 'Ism familiya', key: 'name', width: 25 },
      { header: 'Telegram Username', key: 'username', width: 20 },
      { header: 'Telefon', key: 'phone', width: 15 }
    ];

    worksheet.getRow(1).font = { bold: true, size: 11 };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    let rowNum = 1;
    for (const [userId, user] of userData.entries()) {
      const rowData = {
        rowNum: rowNum,
        name: user.name || '',
        username: user.username ? `@${user.username}` : '',
        phone: user.phone || ''
      };

      const newRow = worksheet.addRow(rowData);
      newRow.alignment = { vertical: 'middle', horizontal: 'left' };
      newRow.height = 25;

      rowNum++;
    }

    console.log(`Jami ${userData.size} ta ishchi ro'yxatga qo'shildi`);
    await workbook.xlsx.writeFile(reportPath);
    return reportPath;
  } catch (error) {
    console.error('Excel yaratishda xatolik:', error);
    throw error;
  }
}

async function sendDailyReportToAdmin() {
  if (!ADMIN_ID) {
    console.log('ADMIN_ID mavjud emas, kunlik hisobot yuborilmadi');
    return;
  }

  try {
    console.log('Kunlik hisobot tayyorlanmoqda...');

    const reportPath = await generateUsersPersonalDataReport();

    if (!reportPath || !fs.existsSync(reportPath)) {
      console.log('Bugun hech qanday ma\'lumot yo\'q');
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `KUNLIK HISOBOT\n\nSana: ${getDate()}\nVaqt: ${getTime()}\n\nBugun hech qanday ishchi ma'lumoti mavjud emas.`
      );
      return;
    }

    await bot.telegram.sendDocument(
      ADMIN_ID,
      { source: reportPath },
      {
        caption: `KUNLIK HISOBOT (Barcha ishchilar ma'lumotlari)\n\nSana: ${getDate()}\nVaqt: ${getTime()}\n\nBarcha ro'yxatdan o'tgan ishchilarning to'liq ma'lumotlari`
      }
    );

    const targetGroupId = ADMIN_GROUP_ID || GROUP_ID;
    if (targetGroupId) {
      await bot.telegram.sendDocument(
        targetGroupId,
        { source: reportPath },
        {
          caption: `KUNLIK HISOBOT (Barcha ishchilar ma'lumotlari)\n\nSana: ${getDate()}\nVaqt: ${getTime()}\n\nBarcha ro'yxatdan o'tgan ishchilarning to'liq ma'lumotlari`
        }
      );
      console.log('Kunlik hisobot gruppaga ham yuborildi');
    } else {
      console.log('GROUP_ID mavjud emas, faqat adminga yuborildi');
    }

    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }

    console.log(`Kunlik hisobot admin ga yuborildi: ${getDate()} ${getTime()}`);
  } catch (error) {
    console.error('Kunlik hisobotni yuborishda xatolik:', error);
  }
}

function scheduleDailyReportSending() {
  cron.schedule('59 23 * * *', () => {
    console.log('Soat 23:59, kunlik hisobot yuborilmoqda...');
    sendDailyReportToAdmin();
  }, {
    timezone: TIMEZONE
  });

  console.log('Kunlik avtomatik hisobot tizimi ishga tushdi (har kuni soat 23:59 da admin va gruppaga)');
}

function adminMenu() {
  return Markup.keyboard([
    ['📤 Ishchilarning kunlik ma\'lumotini yuklash'],
    ['📋 Barcha ishchilar ro\'yxati']
  ]).resize();
}

function workerMenu() {
  return Markup.keyboard([
    ['🟢 Ishni boshlash', '📹 Jonli video'],
    ['💸 Avans', '📊 Xarajatlar'],
    ['💬 Izoh yoki savol', '🔴 Ishni tugatish']
  ]).resize();
}


function expenseMenu() {
  return Markup.keyboard([
    ['🚕 Taxi', '🍔 Ovqat', '📦 Boshqalar'],
    ['🔙 Asosiy menyu']
  ]).resize();
}


function diplomMenu() {
  return Markup.keyboard([
    ['🎓 Diplom mavjud emas']
  ]).resize();
}

function checkSpamming(userId) {
  const userIdString = normalizeId(userId);
  const now = Date.now();
  const userDataLocal = userMessageCount.get(userIdString) || { count: 0, lastReset: now };

  if (now - userDataLocal.lastReset > 60000) {
    userDataLocal.count = 0;
    userDataLocal.lastReset = now;
  }

  userDataLocal.count++;
  userMessageCount.set(userIdString, userDataLocal);

  return userDataLocal.count > 20;
}

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const username = ctx.from.username || '';
  const isAdmin = userId === ADMIN_ID;

  if (isAdmin) {
    userStates.set(userId, 'admin_menu');
    return ctx.reply('Admin menyusi:', adminMenu());
  }

  if (userData.has(userId)) {
    userStates.set(userId, 'main_menu');
    return ctx.reply('Xush kelibsiz!\n\nAsosiy menyu:', workerMenu());
  }

  userStates.set(userId, 'waiting_name');

  if (!userData.has(userId)) {
    userData.set(userId, { username: username });
  } else {
    const user = userData.get(userId);
    user.username = username;
    userData.set(userId, user);
  }

  await ctx.reply('Xush kelibsiz!\n\nIsm, familiya, otangizning ismini kiriting:');
});

bot.on('contact', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);
  const user = userData.get(userId) || {};

  if (state === 'waiting_phone') {
    const contact = ctx.message.contact;
    user.phone = contact.phone_number.replace(/[^\d]/g, '');
    userData.set(userId, user);
    saveUserData();

    userStates.set(userId, 'waiting_passport_serial');
    await ctx.reply('Pasport yoki ID kartangizning seriya raqamini kiriting:');
  }
});

bot.on('text', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);
  const user = userData.get(userId) || {};
  const text = ctx.message.text;
  const isAdmin = userId === ADMIN_ID;

  if (checkSpamming(userId)) {
    return ctx.reply('Iltimos, faqat ish ma\'lumotlarini kiriting. Ortiqcha xabar yuborish taqiqlanadi.');
  }

  if (text === 'Asosiy menyu' || text.includes('Asosiy menyu')) {
    if (isAdmin) {
      userStates.set(userId, 'admin_menu');
      return ctx.reply('Admin menyusi:', adminMenu());
    } else {
      userStates.set(userId, 'main_menu');
      return ctx.reply('Asosiy menyu:', workerMenu());
    }
  }

  if (text === 'Diplom mavjud emas' || text.includes('Diplom mavjud emas')) {
    if (state === 'waiting_diplom_serial_or_skip') {
      user.hasDiploma = false;
      user.diplomSerial = 'Mavjud emas';
      userData.set(userId, user);
      saveUserData();

      const skipMsg = `DIPLOM MAVJUD EMAS\n\nIsm: ${user.name}\nTel: ${user.phone}`;
      await sendAdminNotification(skipMsg);
      await sendGroupNotification(skipMsg);

      userStates.set(userId, 'main_menu');
      await ctx.reply('Ro\'yxatdan o\'tish muvaffaqiyatli yakunlandi!', workerMenu());
      return;
    }
  }

  if (state === 'admin_menu' || isAdmin) {
    if (text === 'Ishchilarning kunlik ma\'lumotini yuklash' || text.includes('kunlik ma\'lumotini yuklash')) {
      try {
        await ctx.reply('Excel fayli tayyorlanmoqda, iltimos kuting...');

        const reportPath = await generateUsersPersonalDataReport();

        if (!reportPath) {
          await ctx.reply('Hali hech qanday ishchi ma\'lumotlari mavjud emas!', adminMenu());
          return;
        }

        await ctx.replyWithDocument(
          { source: reportPath },
          {
            caption: `Barcha ishchilar shaxsiy ma'lumotlari\nSana: ${getDate()}\nVaqt: ${getTime()}\n\nBarcha ro'yxatdan o'tgan ishchilarning to'liq ma'lumotlari`
          }
        );

        if (fs.existsSync(reportPath)) {
          fs.unlinkSync(reportPath);
        }

        await ctx.reply('Fayl muvaffaqiyatli yuklandi!', adminMenu());
      } catch (error) {
        console.error('Excel yaratishda xatolik:', error);
        await ctx.reply('Fayl yaratishda xatolik yuz berdi. Iltimos qaytadan urinib ko\'ring.', adminMenu());
      }
      return;
    }

    if (text === 'Barcha ishchilar ro\'yxati' || text.includes('Barcha ishchilar ro\'yxati')) {
      try {
        await ctx.reply('Excel fayli tayyorlanmoqda...');

        const reportPath = await generateAllUsersReport();

        await ctx.replyWithDocument(
          { source: reportPath },
          {
            caption: `Barcha ishchilar ro'yxati\nSana: ${getDate()}\nVaqt: ${getTime()}\n\nBotdan ro'yxatdan o'tgan barcha ishchilarning ism, familiya, telegram username va telefon raqamlari`
          }
        );

        if (fs.existsSync(reportPath)) {
          fs.unlinkSync(reportPath);
        }

        await ctx.reply('Fayl muvaffaqiyatli yuklandi!', adminMenu());
      } catch (error) {
        console.error('Excel yaratishda xatolik:', error);
        await ctx.reply('Fayl yaratishda xatolik yuz berdi.');
      }
      return;
    }
  }

  switch (state) {
    case 'waiting_name':
      user.name = text;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_phone');
      await ctx.reply('Telefon raqamingizni yuboring:',
        Markup.keyboard([
          [Markup.button.contactRequest('Telefon raqamni yuborish')]
        ]).resize().oneTime()
      );
      break;

    case 'waiting_phone':
      const cleanPhone = text.replace(/[^\d]/g, '');
      if (!cleanPhone.startsWith('998') || cleanPhone.length < 12) {
        return ctx.reply('Telefon raqam +998 bilan boshlanishi va to\'g\'ri formatda bo\'lishi kerak. Qaytadan kiriting:');
      }

      user.phone = cleanPhone;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_passport_serial');
      await ctx.reply('Pasport yoki ID kartangizning seriya raqamini kiriting:');
      break;

    case 'waiting_passport_serial':
      user.passportSerial = text;
      user.passportPhotos = [];
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_passport_photo');
      await ctx.reply('Pasport yoki ID kartangizning rasmini yuboring.\n\nIltimos, OLDI va ORQA tomondan 2 ta rasm yuboring (jami 2 ta).');
      break;

    case 'waiting_diplom_serial':
      user.diplomSerial = text;
      user.diplomPhotos = [];
      user.hasDiploma = true;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_diplom_photo');
      await ctx.reply('Diplomingizning rasmini yuboring.\n\nIltimos, OLDI va ORQA tomondan 2 ta rasm yuboring (jami 2 ta).');
      break;

    case 'waiting_diplom_serial_or_skip':
      user.diplomSerial = text;
      user.diplomPhotos = [];
      user.hasDiploma = true;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_diplom_photo');
      await ctx.reply('Diplomingizning rasmini yuboring.\n\nIltimos, OLDI va ORQA tomondan 2 ta rasm yuboring (jami 2 ta).');
      break;

    case 'waiting_object_start':
      const objectName = text;
      const session = {
        object: objectName,
        date: getDate(),
        startTime: getTime(),
        startDateTime: getDateTime(),
        startLocation: '',
        endLocation: '',
        endTime: '',
        endDateTime: null,
        avans: 0,
        taxiExpense: 0,
        foodExpense: 0,
        otherExpense: 0,
        otherExpenses: [],
        comments: [],
        hasVideo: false
      };

      workSessions.set(userId, session);
      saveWorkSessions();

      user.currentObject = objectName;
      userData.set(userId, user);
      saveUserData();

      console.log(`Sessiya yaratildi: ${user.name} (ID: ${userId}) startTime: ${session.startTime}`);

      userStates.set(userId, 'waiting_start_location');
      await ctx.reply('Iltimos, lokatsiyangizni yuboring:',
        Markup.keyboard([
          [Markup.button.locationRequest('Lokatsiya yuborish')]
        ]).resize().oneTime()
      );
      break;

    case 'waiting_avans_amount':
      if (isNaN(text) || text.trim() === '') {
        return ctx.reply('Iltimos, faqat son kiriting:');
      }

      const session2 = getOrCreateSession(userId);
      session2.avans = (session2.avans || 0) + parseFloat(text);
      workSessions.set(userId, session2);
      saveWorkSessions();

      const avansMsg = `AVANS SO'ROVI\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nSumma: ${text} so'm\nObyekt: ${session2.object || 'Yo\'q'}`;
      await sendAdminNotification(avansMsg);
      await sendGroupNotification(avansMsg);

      userStates.set(userId, 'main_menu');
      await ctx.reply('Avans so\'rovi qabul qilindi.', workerMenu());
      break;

    case 'waiting_other_expense_name':
      user.tempExpenseName = text;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_other_expense_amount');
      await ctx.reply('Endi summasini kiriting (so\'mda):');
      break;

    case 'waiting_other_expense_amount':
      if (isNaN(text) || text.trim() === '') {
        return ctx.reply('Iltimos, faqat son kiriting:');
      }

      const amount2 = parseFloat(text);
      const session5 = getOrCreateSession(userId);

      if (!session5.otherExpenses) {
        session5.otherExpenses = [];
      }

      session5.otherExpenses.push({
        name: user.tempExpenseName || 'Noma\'lum',
        amount: amount2,
        date: getDate(),
        time: getTime()
      });

      workSessions.set(userId, session5);
      saveWorkSessions();

      const otherExpenseMsg = `XARAJAT (Boshqalar)\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nTuri: ${user.tempExpenseName}\nSumma: ${text} so'm\nObyekt: ${session5.object || 'Yo\'q'}`;
      await sendAdminNotification(otherExpenseMsg);
      await sendGroupNotification(otherExpenseMsg);

      delete user.tempExpenseName;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'expense_menu');
      await ctx.reply('Xarajat qayd etildi.', expenseMenu());
      break;

    case 'waiting_expense_amount':
      if (isNaN(text) || text.trim() === '') {
        return ctx.reply('Iltimos, faqat son kiriting:');
      }

      const amount = parseFloat(text);
      const session3 = getOrCreateSession(userId);

      if (user.expenseType === 'Taxi') {
        session3.taxiExpense = (session3.taxiExpense || 0) + amount;
      } else if (user.expenseType === 'Ovqat') {
        session3.foodExpense = (session3.foodExpense || 0) + amount;
      }
      workSessions.set(userId, session3);
      saveWorkSessions();

      const totalExp = (session3.avans || 0) + (session3.taxiExpense || 0) + (session3.foodExpense || 0);
      console.log(`Xarajat qo'shildi: ${user.expenseType} "${text}" ${amount} — totalExpense: ${totalExp}`);

      const expenseMsg = `XARAJAT\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nTuri: ${user.expenseType}\nSumma: ${text} so'm\nObyekt: ${session3.object || 'Yo\'q'}`;
      await sendAdminNotification(expenseMsg);
      await sendGroupNotification(expenseMsg);

      userStates.set(userId, 'expense_menu');
      await ctx.reply('Xarajat qayd etildi.', expenseMenu());
      break;

    case 'waiting_comment':
      const session4 = getOrCreateSession(userId);
      if (!session4.comments) session4.comments = [];
      session4.comments.push(text);
      workSessions.set(userId, session4);
      saveWorkSessions();

      const commentMsg = `IZOH/SAVOL\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nObyekt: ${session4.object || 'Yo\'q'}\n\nXabar:\n${text}`;
      await sendAdminNotification(commentMsg);
      await sendGroupNotification(commentMsg);

      userStates.set(userId, 'main_menu');
      await ctx.reply('Xabar yuborildi.', workerMenu());
      break;

    case 'waiting_object_end':
      user.pendingEndObject = text;
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_end_location');
      await ctx.reply('Iltimos, lokatsiyangizni yuboring:',
        Markup.keyboard([
          [Markup.button.locationRequest('Lokatsiya yuborish')]
        ]).resize().oneTime()
      );
      break;

    case 'main_menu':
      if (text.includes('Ishni boshlash')) {
        const existingSession = workSessions.get(userId);
        if (existingSession && !existingSession.endTime) {
          return ctx.reply('Siz allaqachon ish boshlagansiz! Avval joriy ishni tugatishingiz kerak.');
        }

        userStates.set(userId, 'waiting_object_start');
        await ctx.reply('Obyekt nomini kiriting:');
      } else if (text.includes('Jonli video')) {
        getOrCreateSession(userId);
        userStates.set(userId, 'waiting_live_video');
        await ctx.reply('Iltimos, FAQAT Telegram ichida yumaloq video yozing va yuboring.\n\nGalereyadan video yuklash mumkin emas!');
      } else if (text.includes('Avans')) {
        getOrCreateSession(userId);
        userStates.set(userId, 'waiting_avans_amount');
        await ctx.reply('Avans miqdorini kiriting (so\'mda):');
      } else if (text.includes('Xarajatlar')) {
        getOrCreateSession(userId);
        userStates.set(userId, 'expense_menu');
        await ctx.reply('Xarajat turini tanlang:', expenseMenu());
      } else if (text.includes('Izoh')) {
        getOrCreateSession(userId);
        userStates.set(userId, 'waiting_comment');
        await ctx.reply('Izoh yoki savolingizni yozing:');
      } else if (text.includes('tugatish')) {
        const existingSession = workSessions.get(userId);
        if (!existingSession || existingSession.endTime) {
          return ctx.reply('Siz hali ish boshlamagansiz!');
        }

        userStates.set(userId, 'waiting_object_end');
        await ctx.reply('Obyekt nomini tasdiqlang yoki o\'zgartiring:',
          Markup.keyboard([
            [existingSession.object],
            ['Asosiy menyu']
          ]).resize()
        );
      } else {
        return ctx.reply('Iltimos, faqat menyudagi tugmalardan foydalaning.');
      }
      break;

    case 'expense_menu':
      if (text.includes('Taxi')) {
        user.expenseType = 'Taxi';
        userData.set(userId, user);
        saveUserData();

        userStates.set(userId, 'waiting_expense_amount');
        await ctx.reply('Taxi xarajati summani kiriting (so\'mda):');
      } else if (text.includes('Ovqat')) {
        user.expenseType = 'Ovqat';
        userData.set(userId, user);
        saveUserData();

        userStates.set(userId, 'waiting_expense_amount');
        await ctx.reply('Ovqat xarajati summani kiriting (so\'mda):');
      } else if (text.includes('Boshqalar')) {
        userStates.set(userId, 'waiting_other_expense_name');
        await ctx.reply('Xarajat nomini kiriting:');
      }
      break;
  }
});

bot.on('photo', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);
  const user = userData.get(userId) || {};

  const fileId = ctx.message.photo && ctx.message.photo.length
    ? ctx.message.photo[ctx.message.photo.length - 1].file_id
    : null;

  if (state === 'waiting_passport_photo') {
    if (!user.passportPhotos) user.passportPhotos = [];
    user.passportPhotos.push(fileId);
    userData.set(userId, user);
    saveUserData();

    if (user.passportPhotos.length < 2) {
      await ctx.reply(`${user.passportPhotos.length}/2 rasm qabul qilindi.\n\nIltimos, ${2 - user.passportPhotos.length} ta rasm yuboring:`);
    } else if (user.passportPhotos.length === 2) {
      for (let i = 0; i < user.passportPhotos.length; i++) {
        const photoMsg = `PASPORT RASMI (${i + 1}/2)\n\nIsm: ${user.name}\nTel: ${user.phone}\nPasport seriya: ${user.passportSerial}`;
        await sendAdminNotification(photoMsg, user.passportPhotos[i]);
        await sendGroupNotification(photoMsg, user.passportPhotos[i]);
      }

      userStates.set(userId, 'waiting_diplom_serial_or_skip');
      await ctx.reply(
        'Pasport muvaffaqiyatli yuklandi!\n\nEndi Diplomingizni seriya raqamini kiriting yoki "Diplom mavjud emas" tugmasini bosing:',
        diplomMenu()
      );
    } else {
      await ctx.reply('Faqat 2 ta rasm kerak! Iltimos, qaytadan boshlang.');
      user.passportPhotos = [];
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_passport_serial');
      await ctx.reply('Pasport yoki ID kartangizning seriya raqamini kiriting:');
    }
  } else if (state === 'waiting_diplom_photo') {
    if (!user.diplomPhotos) user.diplomPhotos = [];
    user.diplomPhotos.push(fileId);
    userData.set(userId, user);
    saveUserData();

    if (user.diplomPhotos.length < 2) {
      await ctx.reply(`${user.diplomPhotos.length}/2 rasm qabul qilindi.\n\nIltimos, ${2 - user.diplomPhotos.length} ta rasm yuboring:`);
    } else if (user.diplomPhotos.length === 2) {
      for (let i = 0; i < user.diplomPhotos.length; i++) {
        const photoMsg = `DIPLOM RASMI (${i + 1}/2)\n\nIsm: ${user.name}\nTel: ${user.phone}\nDiplom seriya: ${user.diplomSerial}`;
        await sendAdminNotification(photoMsg, user.diplomPhotos[i]);
        await sendGroupNotification(photoMsg, user.diplomPhotos[i]);
      }

      userStates.set(userId, 'main_menu');
      await ctx.reply('Diplom muvaffaqiyatli yuklandi!\n\nRo\'yxatdan o\'tish muvaffaqiyatli yakunlandi!', workerMenu());
    } else {
      await ctx.reply('Faqat 2 ta rasm kerak! Iltimos, qaytadan boshlang.');
      user.diplomPhotos = [];
      userData.set(userId, user);
      saveUserData();

      userStates.set(userId, 'waiting_diplom_serial_or_skip');
      await ctx.reply(
        'Diplomingizni seriya raqamini kiriting yoki "Diplom mavjud emas" tugmasini bosing:',
        diplomMenu()
      );
    }
  }
});

bot.on('video', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);

  if (state === 'waiting_live_video') {
    return ctx.reply('Galereyadan video yuklash mumkin emas!\n\nFaqat Telegram ichida YUMALOQ video yozing va yuboring.');
  }
});

bot.on('video_note', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);
  const user = userData.get(userId) || {};

  if (state === 'waiting_live_video') {
    const videoNote = ctx.message.video_note;
    const fileId = videoNote && videoNote.file_id ? videoNote.file_id : 'video_note';

    const session = getOrCreateSession(userId);
    session.hasVideo = true;
    workSessions.set(userId, session);
    saveWorkSessions();

    console.log(`Jonli video qabul qilindi: ${userId} at ${getTime()}`);

    const videoMsg = `JONLI VIDEO (Dumaloq)\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nObyekt: ${session.object || 'Yo\'q'}`;

    if (fileId && fileId !== 'video_note') {
      await sendAdminNotification(videoMsg, null, fileId);
      await sendGroupNotification(videoMsg, null, fileId);
    } else {
      await sendAdminNotification(videoMsg);
      await sendGroupNotification(videoMsg);
    }

    userStates.set(userId, 'main_menu');
    await ctx.reply('Video qayd etildi.', workerMenu());
  }
});

bot.on('location', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return;
  }

  const userId = normalizeId(ctx.from.id);
  const state = userStates.get(userId);
  const user = userData.get(userId) || {};

  const location = ctx.message.location;
  const locationUrl = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;

  user.lastLocation = `${location.latitude},${location.longitude}`;
  userData.set(userId, user);
  saveUserData();

  if (state === 'waiting_start_location') {
    const session = workSessions.get(userId);
    if (session) {
      session.startLocation = locationUrl;
      workSessions.set(userId, session);
      saveWorkSessions();
    }

    const startMsg = `ISH BOSHLANDI\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nObyekt: ${session.object}\nLokatsiya: ${locationUrl}`;
    await sendAdminNotification(startMsg, null, null, location);
    await sendGroupNotification(startMsg, null, null, location);

    userStates.set(userId, 'main_menu');
    await ctx.reply('Ish boshlanishi qayd etildi!', workerMenu());
  } else if (state === 'waiting_end_location') {
    const session = workSessions.get(userId);
    if (session) {
      session.endLocation = locationUrl;
      session.endTime = getTime();
      session.endDateTime = getDateTime();
      workSessions.set(userId, session);
      saveWorkSessions();

      console.log(`Ishni tugatish: ${user.name} (ID: ${userId})`);
      await finalizeWorkSession(userId);
    }

    const endMsg = `ISH TUGATILDI\n\nIsm: ${user.name}\nTel: ${user.phone}\nSana: ${getDate()}\nVaqt: ${getTime()}\nObyekt: ${user.pendingEndObject || user.currentObject}\nLokatsiya: ${locationUrl}`;
    await sendAdminNotification(endMsg, null, null, location);
    await sendGroupNotification(endMsg, null, null, location);

    user.currentObject = '';
    delete user.pendingEndObject;
    userData.set(userId, user);
    saveUserData();

    userStates.set(userId, 'main_menu');
    await ctx.reply('Ish tugashi qayd etildi! Ma\'lumotlar hisobotga qo\'shildi.', workerMenu());
  }
});

bot.launch().then(() => {
  console.log('Bot ishga tushdi!');
  scheduleDailyReportSending();
}).catch((err) => {
  console.error('Bot ishga tushmadi:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));