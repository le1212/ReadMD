'use strict';

const {
  Document,
  Packer,
  Footer,
  Header,
  PageBreak,
  PageNumber,
  Paragraph,
  TableOfContents,
  TextRun,
  AlignmentType,
  BorderStyle,
  LineRuleType
} = require('docx');
const { htmlToContent } = require('docx/html');
const { parse } = require('node-html-parser');
const { buildDocxCss } = require('./styles');
const { collectImages } = require('./images');
const { parseWithHeadings } = require('./headings');

const FONT_BODY_EAST_ASIA = '宋体';
const FONT_BODY_LATIN = 'Times New Roman';
const FONT_HEADING_EAST_ASIA = '黑体';
const FONT_HEADING_LATIN = 'Arial';
const FONT_MONO = 'Consolas';

const PAGE = {
  width: 11906, // A4 210mm
  height: 16838, // A4 297mm
  marginTop: 1440, // 2.54cm
  marginBottom: 1440,
  marginLeft: 1797, // 3.17cm
  marginRight: 1797,
  header: 720,
  footer: 720
};

const TEXT = {
  body: '1F2328',
  heading: '111827',
  muted: '57606A',
  faint: '8C959F',
  line: 'D0D7DE',
  lineSoft: 'E5E7EB',
  soft: 'F6F8FA',
  quoteSoft: 'F8F9FA',
  tableHead: 'F3F4F6',
  accent: '0969DA'
};

const WARNING_TEXT = {
  'unsupported-element': '有不支持的元素已被忽略',
  'missing-image': '有图片缺失，已跳过',
  'unsupported-image': '有图片格式 Word 无法显示，已跳过',
  'unsafe-link': '有不安全链接已被移除',
  'invalid-math': '有公式无法解析，已保留原文',
  'too-deep': '有内容层级过深，已简化格式',
  'block-in-paragraph': '有块级内容被合并进段落',
  'table-in-note': '脚注中的表格已简化'
};

function bodyFont() {
  return {
    ascii: FONT_BODY_LATIN,
    eastAsia: FONT_BODY_EAST_ASIA,
    hAnsi: FONT_BODY_LATIN,
    cs: FONT_BODY_LATIN
  };
}

function headingFont() {
  return {
    ascii: FONT_HEADING_LATIN,
    eastAsia: FONT_HEADING_EAST_ASIA,
    hAnsi: FONT_HEADING_LATIN,
    cs: FONT_HEADING_LATIN
  };
}

function formatDate(date = new Date()) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const STYLE_MAP = {
  h1: 'Heading1',
  h2: 'Heading2',
  h3: 'Heading3',
  h4: 'Heading4',
  h5: 'Heading5',
  h6: 'Heading6',
  blockquote: 'Quote',
  'blockquote p': 'Quote',
  pre: 'SourceCode',
  code: 'VerbatimChar',
  li: 'ListParagraph',
  a: 'Hyperlink'
};

function paragraphStyle({ id, name, basedOn = 'Normal', next = 'Normal', quickFormat = true, run, paragraph }) {
  return { id, name, basedOn, next, quickFormat, run, paragraph };
}

function documentStyles() {
  return {
    default: {
      document: {
        run: {
          font: {
            ascii: FONT_BODY_LATIN,
            eastAsia: FONT_BODY_EAST_ASIA,
            hAnsi: FONT_BODY_LATIN,
            cs: FONT_BODY_LATIN
          },
          size: 24, // 12pt = 小四
          color: TEXT.body,
          characterSpacing: 4, // 0.2pt，中文正文的轻微呼吸感
          language: { value: 'en-US', eastAsia: 'zh-CN' }
        },
        paragraph: {
          spacing: { line: 360, lineRule: LineRuleType.AUTO, before: 0, after: 120 },
          widowControl: true
        }
      },
      heading1: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 44, // 22pt
          bold: true,
          color: TEXT.heading,
          characterSpacing: 8
        },
        paragraph: {
          spacing: { before: 480, after: 240, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TEXT.lineSoft, space: 6 } }
        }
      },
      heading2: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 34, // 17pt
          bold: true,
          color: TEXT.heading,
          characterSpacing: 6
        },
        paragraph: {
          spacing: { before: 360, after: 180, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true
        }
      },
      heading3: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 30, // 15pt
          bold: true,
          color: TEXT.heading,
          characterSpacing: 4
        },
        paragraph: {
          spacing: { before: 300, after: 120, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true
        }
      },
      heading4: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 26, // 13pt
          bold: true,
          color: TEXT.heading,
          characterSpacing: 4
        },
        paragraph: {
          spacing: { before: 240, after: 120, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true
        }
      },
      heading5: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 24, // 12pt
          bold: true,
          color: TEXT.heading,
          characterSpacing: 4
        },
        paragraph: {
          spacing: { before: 200, after: 100, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true
        }
      },
      heading6: {
        run: {
          font: { ascii: FONT_HEADING_LATIN, eastAsia: FONT_HEADING_EAST_ASIA, hAnsi: FONT_HEADING_LATIN, cs: FONT_HEADING_LATIN },
          size: 22, // 11pt
          bold: true,
          color: TEXT.muted,
          characterSpacing: 4
        },
        paragraph: {
          spacing: { before: 180, after: 100, line: 360, lineRule: LineRuleType.AUTO },
          keepNext: true,
          keepLines: true
        }
      },
      hyperlink: {
        run: { color: TEXT.accent, underline: { type: 'single' } }
      },
      footnoteText: {
        run: { size: 18, color: TEXT.muted, characterSpacing: 2 },
        paragraph: {
          spacing: { line: 300, lineRule: LineRuleType.AUTO, before: 0, after: 60 },
          widowControl: true
        }
      },
      footnoteReference: {
        run: { color: TEXT.accent, superScript: true }
      }
    },
    paragraphStyles: [
      paragraphStyle({
        id: 'Quote',
        name: 'Quote',
        run: { color: TEXT.muted },
        paragraph: {
          spacing: { before: 180, after: 180, line: 360, lineRule: LineRuleType.AUTO },
          indent: { left: 240, right: 240 },
          border: { left: { style: BorderStyle.SINGLE, size: 24, color: TEXT.line, space: 12 } },
          shading: { type: 'clear', fill: TEXT.quoteSoft }
        }
      }),
      paragraphStyle({
        id: 'SourceCode',
        name: 'Source Code',
        run: {
          font: { ascii: FONT_MONO, eastAsia: FONT_MONO, hAnsi: FONT_MONO, cs: FONT_MONO },
          size: 19, // 9.5pt
          color: TEXT.body,
          characterSpacing: 0
        },
        paragraph: {
          spacing: { before: 180, after: 240, line: 280, lineRule: LineRuleType.AUTO },
          indent: { left: 120, right: 120 },
          shading: { type: 'clear', fill: TEXT.soft },
          border: {
            top: { style: BorderStyle.SINGLE, size: 4, color: TEXT.line, space: 4 },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: TEXT.line, space: 4 },
            left: { style: BorderStyle.SINGLE, size: 4, color: TEXT.line, space: 4 },
            right: { style: BorderStyle.SINGLE, size: 4, color: TEXT.line, space: 4 }
          }
        }
      }),
      paragraphStyle({
        id: 'ListParagraph',
        name: 'List Paragraph',
        quickFormat: false,
        paragraph: {
          spacing: { line: 360, lineRule: LineRuleType.AUTO, before: 0, after: 60 }
        }
      })
    ],
    characterStyles: [
      {
        id: 'VerbatimChar',
        name: 'Verbatim Char',
        basedOn: 'DefaultParagraphFont',
        quickFormat: true,
        run: {
          font: { ascii: FONT_MONO, eastAsia: FONT_MONO, hAnsi: FONT_MONO, cs: FONT_MONO },
          size: 19,
          color: TEXT.body,
          characterSpacing: 0,
          shading: { type: 'clear', fill: TEXT.soft }
        }
      }
    ]
  };
}

function coverParagraphs(title, settings) {
  const paragraphs = [
    new Paragraph({
      spacing: { before: 1800, after: 240 },
      children: [new TextRun({
        text: String(title || '未命名文档').slice(0, 120),
        size: 64,
        bold: true,
        color: TEXT.heading,
        font: headingFont(),
        characterSpacing: 12
      })]
    }),
    new Paragraph({
      spacing: { before: 0, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEXT.heading, space: 12 } },
      children: []
    })
  ];

  if (settings.coverSubtitle) {
    paragraphs.push(new Paragraph({
      spacing: { before: 0, after: 120 },
      children: [new TextRun({
        text: settings.coverSubtitle,
        size: 30,
        color: TEXT.muted,
        font: bodyFont(),
        characterSpacing: 4
      })]
    }));
  }

  const meta = [settings.coverAuthor, formatDate()].filter(Boolean);
  meta.forEach((text, index) => {
    paragraphs.push(new Paragraph({
      spacing: { before: index === 0 ? 3000 : 0, after: 80 },
      border: index === 0
        ? { top: { style: BorderStyle.SINGLE, size: 4, color: TEXT.lineSoft, space: 8 } }
        : undefined,
      children: [new TextRun({
        text,
        size: 20,
        color: index === 0 ? TEXT.muted : TEXT.faint,
        font: bodyFont(),
        characterSpacing: 2
      })]
    }));
  });

  paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
  return paragraphs;
}

function tocParagraphs() {
  return [
    new Paragraph({
      spacing: { before: 0, after: 240 },
      children: [new TextRun({
        text: '目录',
        size: 36,
        bold: true,
        color: TEXT.heading,
        font: headingFont(),
        characterSpacing: 8
      })]
    }),
    new TableOfContents('目录', {
      hyperlink: true,
      headingStyleRange: '1-4'
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

function header(title) {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: TEXT.lineSoft, space: 4 } },
      children: [new TextRun({
        text: String(title || '').slice(0, 80),
        size: 16,
        color: TEXT.faint,
        font: bodyFont(),
        characterSpacing: 2
      })]
    })]
  });
}

function emptyHeader() {
  return new Header({ children: [new Paragraph({ children: [] })] });
}

function emptyFooter() {
  return new Footer({ children: [new Paragraph({ children: [] })] });
}

function footer() {
  const makeRun = (text) => new TextRun({
    text,
    size: 16,
    color: TEXT.faint,
    font: { ascii: FONT_BODY_LATIN, eastAsia: FONT_BODY_EAST_ASIA, hAnsi: FONT_BODY_LATIN },
    characterSpacing: 2
  });

  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [
          makeRun('第 '),
          new TextRun({
            children: [PageNumber.CURRENT],
            size: 16,
            color: TEXT.faint,
            font: { ascii: FONT_BODY_LATIN, eastAsia: FONT_BODY_EAST_ASIA, hAnsi: FONT_BODY_LATIN },
            characterSpacing: 2
          }),
          makeRun(' 页 / 共 '),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            size: 16,
            color: TEXT.faint,
            font: { ascii: FONT_BODY_LATIN, eastAsia: FONT_BODY_EAST_ASIA, hAnsi: FONT_BODY_LATIN },
            characterSpacing: 2
          }),
          makeRun(' 页')
        ]
      })
    ]
  });
}

function plainTextFallback(html) {
  try {
    const root = parse(html || '');
    const text = root.text.replace(/\s+\n/g, '\n').trim();
    if (!text) return [];
    return text
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => new Paragraph({
        children: [new TextRun(chunk)]
      }));
  } catch {
    return [];
  }
}

async function buildDocxBuffer({ title, html, baseDir, settings = {} }) {
  const options = settings || {};
  const { images, notes } = await collectImages(html, baseDir);
  const warnings = new Set(notes);
  let content = [];

  try {
    content = htmlToContent(String(html || ''), {
      stylesheet: buildDocxCss(options),
      styleMap: STYLE_MAP,
      images: (source) => images.get(source),
      maxImageWidth: 560,
      notes: 'footnotes',
      onWarning: (warning) => {
        const text = WARNING_TEXT[warning.code] || '有内容未能完整转换';
        warnings.add(text);
      }
    });
  } catch {
    warnings.add('文档结构较复杂，已按纯文本导出');
  }

  if (!content.length) content = plainTextFallback(html);

  let headings = [];
  try {
    headings = parseWithHeadings(String(html || '')).headings;
  } catch {
    // 没有可用标题时只跳过目录，不影响正文
  }

  const front = [];
  if (options.cover) front.push(...coverParagraphs(title, options));
  if (options.toc && headings.length >= 2) front.push(...tocParagraphs());

  const headers = options.header ? { default: header(title) } : null;
  const footers = options.footer ? { default: footer() } : null;
  if (options.cover) {
    if (headers) headers.first = emptyHeader();
    if (footers) footers.first = emptyFooter();
  }

  const doc = new Document({
    title: String(title || '未命名文档'),
    creator: 'ReadMD',
    lastModifiedBy: 'ReadMD',
    description: '由 ReadMD 导出',
    styles: documentStyles(),
    features: { updateFields: true },
    sections: [{
      properties: {
        ...(options.cover ? { titlePage: true } : {}),
        page: {
          size: { width: PAGE.width, height: PAGE.height },
          margin: {
            top: PAGE.marginTop,
            bottom: PAGE.marginBottom,
            left: PAGE.marginLeft,
            right: PAGE.marginRight,
            header: PAGE.header,
            footer: PAGE.footer
          }
        }
      },
      ...(headers ? { headers } : {}),
      ...(footers ? { footers } : {}),
      children: [...front, ...content]
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, warnings: Array.from(warnings) };
}

module.exports = {
  buildDocxBuffer
};
