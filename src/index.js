const puppeteer = require('puppeteer');
const { lawList } = require('./law_data');
const fs = require('fs');
const XLSX = require('xlsx');

let lawInformationCrawler = async () => {
  const browser = await puppeteer.launch({
    headless: process.env.NODE_ENV === 'production',
  });

  let jsonTree = [];

  for (let i = 0; i < lawList.length; i++) {
    const page = await browser.newPage();
    const url = 'https://www.law.go.kr/법령/' + lawList[i];
    await page.goto(url);

    // page 내부의 iframe을 획득
    const iframeSource = await page.$eval(
      'iframe#lawService',
      (iframe) => iframe.src
    );

    // iframe이 갖는 src로 이동
    await page.goto(iframeSource);

    // 제목
    let title = (
      await page.evaluate(
        (element) => element.textContent,
        await page.waitForSelector('#conTop > h2')
      )
    ).trim();

    // 부제목
    let subtitle = (
      await page.evaluate(
        (element) => element.textContent,
        await page.waitForSelector('#conTop > div.ct_sub > span')
      )
    ).trim();

    // 담당 부서
    const department = (
      await page.evaluate(
        (element) => element.textContent,
        await page.waitForSelector('#conScroll > div.cont_subtit')
      )
    ).trim();

    jsonTree.push({
      title: title,
      substring: subtitle,
      department: department,
    });

    await page.waitForSelector('div.pgroup');
    const rootElements = await page.$$('div.pgroup');

    // pgroup 단위로 관리
    for (const rootElement of rootElements) {
      // 조, 항, 호, 목에 해당
      const childrenOfPgroup = await rootElement.$$(
        '.pgroup .lawcon > .pty1_p4, .pgroup .lawcon > .pty1_de2_1, .pgroup .lawcon > .pty1_de2h, .pgroup .lawcon > .pty1_de3'
      );

      if (childrenOfPgroup.length) {
        // 조 단위의 법률 세트
        const lawSet = await parseElementData(page, childrenOfPgroup);

        // 조 단위로 묵인 하위 법들을 조정해서 jsonTree를 생성
        let temporaryJsonTree = await createJsonTreeElement(lawSet);
        jsonTree.push(temporaryJsonTree);
      }
    }

    createJsonFileToMultiXlsx(jsonTree);
    jsonTree = []; //배열 비우기
    // console.log(jsonTree);
    await page.close();
  }
};

async function parseElementData(page, dataArray) {
  let lawObjectArray = [];
  for (const data of dataArray) {
    const t = await data.evaluate((element) => Array.from(element.classList)); // 클래스명 배열로 가져오기
    const type = t.includes('pty1_p4')
      ? '조'
      : t.includes('pty1_de2_1')
      ? '항'
      : t.includes('pty1_de2h')
      ? '호'
      : t.includes('pty1_de3')
      ? '목'
      : '세부정보';

    const text = await page.evaluate((element) => element.textContent, data); // 요소의 텍스트 추출

    lawObjectArray.push({
      type: type,
      content: text.trim(),
      children: [],
    });
  }

  return lawObjectArray;
}

async function createJsonTreeElement(lawArr) {
  let jsonSet;
  if (lawArr[0].content.includes('①')) {
    jsonSet = {
      type: lawArr[0].type,
      content: lawArr[0].content
        .substring(0, lawArr[0].content.indexOf('①'))
        .trim(),
      children: [
        {
          type: '항',
          content: lawArr[0].content
            .substring(lawArr[0].content.indexOf('①'))
            .trim(),
          children: [],
        },
      ],
    };
  } else {
    jsonSet = {
      type: lawArr[0].type,
      content: lawArr[0].content,
      children: [],
    };
  }

  // 조의 하위 항목이 없는 경우, 조 데이터만 리턴
  if (lawArr.length == 1) {
    return jsonSet;
  } else {
    for (let i = 1; i < lawArr.length; i++) {
      switch (lawArr[i].type) {
        case '항':
          jsonSet.children.push(lawArr[i]);
          break;
        case '호':
          if (lawArr[i - 1].type == '항') {
            jsonSet.children[jsonSet.children.length - 1].children.push(
              lawArr[i]
            );
          } else if (lawArr[i - 1].type == '조') {
            jsonSet.children.push({
              type: '항',
              content: null,
              children: [lawArr[i]],
            });
          } else if (lawArr[i - 1].type == '목') {
            jsonSet.children[jsonSet.children.length - 1].children.push(
              lawArr[i]
            );
          } else if (lawArr[i - 1].type == '호') {
            jsonSet.children[jsonSet.children.length - 1].children.push(
              lawArr[i]
            );
          }
          break;
        case '목':
          if (lawArr[i - 1].type == '호') {
            jsonSet.children[jsonSet.children.length - 1].children[
              jsonSet.children[jsonSet.children.length - 1].children.length - 1
            ].children.push(lawArr[i]);
          } else if (lawArr[i - 1].type == '항') {
            jsonSet.children[jsonSet.children.length - 1].children.push({
              type: '호',
              content: null,
              children: [lawArr[i]],
            });
          } else if (lawArr[i - 1].type == '목') {
            jsonSet.children[jsonSet.children.length - 1].children[
              jsonSet.children[jsonSet.children.length - 1].children.length - 1
            ].children.push(lawArr[i]);
          } else if (lawArr[i - 1].type == '조') {
            jsonSet.children.push({
              type: '항',
              content: null,
              children: [
                {
                  type: '호',
                  content: null,
                  children: [lawArr[i]],
                },
              ],
            });
          }
          break;
        default:
          console.error('예상하지 못한 타입입니다. 다시 확인하시기 바랍니다.');
      }
    }
    // console.log(jsonSet);
    return jsonSet;
  }
}

async function createJsonFileToSingleXlsx(jsonTree) {
  const filePath = './lawInformation.xlsx';
  let existingWorkbook;

  // 기존 엑셀 파일 여부 확인
  if (fs.existsSync(filePath)) {
    // 기존 엑셀 파일이 있을 경우, 기존 엑셀 파일 읽기
    existingWorkbook = XLSX.readFile(filePath);
  } else {
    // 기존 엑셀 파일이 없을 경우, 새로운 워크북 생성
    existingWorkbook = XLSX.utils.book_new();
    console.log(`엑셀 파일이 생성되었습니다: ${filePath}`);
  }
  const lawTitleElement = jsonTree[0];
  const sheetName = lawTitleElement.title;
  const wsData = [['법령명', '시행일', '법률 번호', '담당 기관']];
  wsData.push([
    lawTitleElement.title,
    lawTitleElement.substring,
    '',
    lawTitleElement.department,
  ]);
  wsData.push(['', '', '', '']);
  wsData.push(['조', '항', '호', '목']);

  for (let i = 1; i < jsonTree.length; i++) {
    const item = jsonTree[i];
    if (item.type === '조') {
      wsData.push([item.content, '', '', '']);
      for (const child of item.children) {
        if (child.type === '항') {
          wsData.push(['', child.content, '', '']);
          for (const subChild of child.children) {
            if (subChild.type === '호') {
              // 각 호의 내용 처리
              wsData.push(['', '', subChild.content, '']);
              for (const subSubChild of subChild.children) {
                if (subSubChild.type === '목') {
                  wsData.push(['', '', '', subSubChild.content]);
                }
              }
            }
          }
        }
      }
    }
  }

  // 변환한 시트를 기존 또는 새로운 엑셀 파일에 추가
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(existingWorkbook, ws, sheetName);

  // 엑셀 파일 저장
  XLSX.writeFile(existingWorkbook, filePath);
  console.log(`새로운 시트가 추가된 엑셀 파일이 생성되었습니다: ${filePath}`);
}

async function createJsonFileToMultiXlsx(jsonTree) {
  const lawTitleElement = jsonTree[0];
  const filePath = `./${lawTitleElement.title}.xlsx`;
  let existingWorkbook;

  // 기존 엑셀 파일 여부 확인
  if (fs.existsSync(filePath)) {
    // 기존 엑셀 파일이 있을 경우, 기존 엑셀 파일 읽기
    existingWorkbook = XLSX.readFile(filePath);
  } else {
    // 기존 엑셀 파일이 없을 경우, 새로운 워크북 생성
    existingWorkbook = XLSX.utils.book_new();
    console.log(`엑셀 파일이 생성되었습니다: ${filePath}`);
  }

  const sheetName = '볍률정보';
  const wsData = [['법령명', '시행일', '법률 번호', '담당 기관']];
  wsData.push([
    lawTitleElement.title,
    lawTitleElement.substring,
    '',
    lawTitleElement.department,
  ]);
  wsData.push(['', '', '', '']);
  wsData.push(['조', '항', '호', '목']);

  for (let i = 1; i < jsonTree.length; i++) {
    const item = jsonTree[i];
    if (item.type === '조') {
      wsData.push([item.content, '', '', '']);
      for (const child of item.children) {
        if (child.type === '항') {
          wsData.push(['', child.content, '', '']);
          for (const subChild of child.children) {
            if (subChild.type === '호') {
              // 각 호의 내용 처리
              wsData.push(['', '', subChild.content, '']);
              for (const subSubChild of subChild.children) {
                if (subSubChild.type === '목') {
                  wsData.push(['', '', '', subSubChild.content]);
                }
              }
            }
          }
        }
      }
    }
  }

  // 변환한 시트를 기존 또는 새로운 엑셀 파일에 추가
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(existingWorkbook, ws, sheetName);

  // 엑셀 파일 저장
  XLSX.writeFile(existingWorkbook, filePath);
  console.log(`새로운 시트가 추가된 엑셀 파일이 생성되었습니다: ${filePath}`);
}
lawInformationCrawler();
