import type { KaraokeNumbers } from '@karaoke/schema';

/**
 * Reviewed merge-pair data tables (Tier E + Tier F) extracted from merge.ts
 * (T2-2). This module holds ONLY declarative data: the raw reviewed-pair
 * allowlists, their derived lookup maps, the forbidden-pair guard sets, and the
 * self-validating invariants that run at import time. All clustering/merge
 * LOGIC stays in merge.ts, which imports the exported lookups from here.
 *
 * The invariant assertions execute on import (as before) so a malformed table
 * fails fast at module load, exactly as when they lived in merge.ts.
 */

// --- Vendor identity ------------------------------------------------------

export const VENDORS = [
  'tj',
  'ky',
  'joysound',
] as const satisfies readonly (keyof KaraokeNumbers)[];

export type Vendor = (typeof VENDORS)[number];

export type NonJoysoundVendor = Exclude<Vendor, 'joysound'>;

/**
 * Tier E is intentionally NOT a broad artist-containment rule. `SongRecord`
 * does not preserve JOYSOUND tieups or lyricist/composer evidence, so the safe
 * deployable surface is the exact set of 65 TJ↔JOYSOUND pairs raw-reviewed on
 * 2026-06-13 as `MERGE_CANDIDATE_STRONG`.
 *
 * Excluded by design:
 * - 4 `MERGE_CANDIDATE_REVIEWED` rows that require raw tieup/credit evidence
 *   absent from SongRecord (`Radio Happy`, `ファンサ`, etc.).
 * - 6 `ハッピー☆マテリアル` rows where one TJ number maps to multiple
 *   JOYSOUND monthly/opening variants.
 * - 1 short-token false positive (`FLOW X GRANRODEO` vs `XG`).
 */
const REVIEWED_TIER_E_STRONG_PAIRS = [
  ['6284', '1755'], // 別 離 / 小林幸子 ↔ 別離(わかれ) / 小林幸子
  ['6461', '2978'], // 蒼 月 / 長山洋子 ↔ 蒼月(つき) / 長山洋子
  ['6499', '1976'], // 冬の華 / 大月みやこ ↔ 冬の華(はな) / 大月みやこ
  ['6981', '11726'], // 時 代 / 嵐 ↔ 時代(ジダイ) / 嵐
  ['25017', '495453'], // おもかげ / milet & Aimer & 幾田りら ↔ おもかげ(produced by Vaundy) / milet×Aimer×幾田りら
  ['25031', '492355'], // 六幻 / 林勇 ↔ 佐野万次郎(CV:林勇)
  ['25036', '66685'], // Endless sorrow / 浜崎あゆみ ↔ Endless sorrow〈A Agressive Mix〉 / 浜崎あゆみ (R1 tier-A batch2 2026-07-05)
  ['25134', '492356'], // Rusted Fist / 新祐樹 ↔ 花垣武道(CV:新祐樹)
  ['25219', '681847'], // Departures / globe ↔ DEPARTURES (20th edit) / globe (R1 tier-A 2026-07-05)
  ['25257', '36852'], // For フルーツバスケット / 岡崎律子 外 ↔ 岡崎律子
  ['25258', '16476'], // 勇者王誕生(神話 Ver.) / 遠藤正明 ↔ 勇者王誕生 / 遠藤正明 (R1 tier-A 2026-07-05)
  ['25283', '53411'], // Let Me Be With You / Round table ↔ ROUND TABLE featuring Nino
  ['25372', '26946'], // 御旗のもとに / 巴里華撃団 ↔ 日高のり子ほか (巴里華撃団)
  ['25398', '22323'], // クリスマス タイム / ZARD ↔ クリスマス タイム〈ZARD Version〉 / ZARD (R1 tier-A batch2 2026-07-05)
  ['25468', '27700'], // もっと!モット!ときめき / 金月真美 ↔ 金月真美(藤崎詩織)
  ['25533', '28584'], // さくら / 森山直太朗 ↔ さくら(独唱) / 森山直太朗
  ['25542', '36509'], // storm / JAM Project ↔ JAM Project featuring 水木一郎&影山ヒロノブ
  ['25663', '37378'], // Fire wars / JAM Project ↔ JAM Project featuring 影山ヒロノブ
  ['25715', '4586'], // 恋しさとせつなさと心強さと / 篠原涼子 ↔ 篠原涼子 with t.komuro
  ['25733', '30794'], // 風信子 / 松浦亜弥 ↔ 風信子(ヒヤシンス) / 松浦亜弥
  ['25780', '53543'], // WHITE LINE / 青酢 ↔ 青酢(皆川純子/置鮎龍太郎/近藤孝行/甲斐田ゆき)
  ['25798', '60803'], // Agape / メロキュア ↔ メロキュア(岡崎律子/日向めぐみ)
  ['25898', '10142'], // 渡良瀬橋 / 松浦亜弥 ↔ 渡良瀬橋(わたらせばし) / 松浦亜弥
  ['25918', '65161'], // スクランブル / 堀江由衣 ↔ 堀江由衣 with UNSCANDAL
  ['25963', '32521'], // あぁいいな! / ダブルユー ↔ W(ダブルユー)
  ['26007', '62537'], // チチをもげ! / パルコ・フォルゴレ(高橋広樹) ↔ 高橋広樹
  ['26097', '22484'], // 父親 / 北島三郎 ↔ 父親(おやじ) / 北島三郎
  ['26112', '78294'], // 黄色いバカンス / 桃月学園1年C組(Feat.片桐姫子) ↔ 桃月学園1年C組 feat.片桐姫子(折笠富美子)
  ['26125', '121389'], // Cassis / ガゼット ↔ Cassis / the GazettE
  ['26190', '61149'], // 静かな夜に / 田中理恵 ↔ 田中理恵(ラクス・クライン)
  ['26293', '198114'], // しあわせの魔法 / 丹下桜 ↔ 木之本桜(丹下桜)
  ['26299', '7118'], // 私がオバさんになっても / 森高千里 ↔ 私がオバさんになっても (シングル・ヴァージョン) / 森高千里
  ['26324', '68716'], // くじびきアンバランス / UNDER17 ↔ UNDER17(桃井はるこ)
  ['26333', '30203'], // 恋ing / モーニング娘。 ↔ 恋 ING(アイエヌジー) / モーニング娘。
  ['26334', '71482'], // 魔神見参!! / JAM Project ↔ JAM Project featuring 遠藤正明
  ['26405', '7807'], // 翔べ! ガンダム / 池田 鴻 ↔ 池田鴻/フィーリングフリー/ミュージッククリエイション
  ['26505', '102326'], // 星の在り処 / う～み ↔ ファルコム/う～み
  ['26540', '162503'], // 倦怠ライフ・リターンズ! / 杉田智和 ↔ キョン(杉田智和)
  ['26556', '121767'], // 少女Q / 桃月学園1年C組 ↔ 桃月学園1年C組 feat.上原都(堀江由衣)
  ['26601', '163329'], // 明日は明日の 君が生まれる / AKB48 ↔ Chocolove from AKB48
  ['26633', '57892'], // 愛しいかけら / メロキュア ↔ メロキュア(岡崎律子/日向めぐみ)
  ['26655', '31939'], // Now or Never / CHEMISTRY ↔ CHEMISTRY meets m-flo
  ['26674', '168603'], // メグメル / eufonius ↔ メグメル〈cuckool mix 2007〉 / eufonius (R1 tier-A batch2 2026-07-05)
  ['26701', '163798'], // アンインストール / 石川智晶 ↔ 石川智晶(石川知亜紀)
  ['26731', '166809'], // 人として軸がぶれている / 大槻ケンヂと絶望少女達 ↔ 大槻ケンヂと絶望少女達(...)
  ['26745', '60710'], // Like an angel / 石川智晶 ↔ 石川智晶(石川知亜紀)
  ['26770', '13283'], // SEVENTH MOON / Fire bomber ↔ Fire Bomber featuring BASARA NEKKI
  ['26838', '713387'], // 牙狼~SAVIOR IN THE DARK~(New Ver.) / JAM Project ↔ 牙狼～SAVIOR IN THE DARK～《パチカラ》 / JAM Project (R1 tier-A batch2 2026-07-05)
  ['26849', '69852'], // GREEN / 浜崎あゆみ ↔ GREEN〈Original mix〉 / 浜崎あゆみ (R1 tier-A batch2 2026-07-05, angle-tag surfaced)
  ['26851', '69851'], // Days / 浜崎あゆみ ↔ Days〈Original mix〉 / 浜崎あゆみ (R1 tier-A 2026-07-05, angle-tag surfaced)
  ['26929', '135661'], // 本日、満開ワタシ色 / 桂ヒナギクwith白皇学院生徒会三人娘 ↔ 桂ヒナギク with ...
  ['26961', '162935'], // STORMBRINGER / JAM Project ↔ JAM Project(...)
  ['27386', '198978'], // 上を向いて歩こう / 徳永英明 ↔ 上を向いて歩こう(Strings Ver.) / 徳永英明 (R1 tier-A 2026-07-05)
  ['27655', '94213'], // ミライボウル / ももいろクローバーZ ↔ ももいろクローバー
  ['27800', '728174'], // Cutie Panther / BiBi ↔ BiBi ～... from μ's～
  ['27806', '93640'], // Pledge / ガゼット ↔ PLEDGE / the GazettE
  ['27827', '726997'], // Starlog / ChouCho ↔ ChouCho(ちょうちょ)
  ['27861', '145876'], // CHANGE!!!!(M@STER VER) / 765PRO ALLSTARS ↔ CHANGE!!!!(M@STER VERSION) / 765PRO ALLSTARS
  ['27895', '682372'], // QUESTION / 3年E組うた担 ↔ 3年E組うた担 (...)
  ['27897', '681824'], // もうそうえくすぷれす / 花澤香菜 ↔ 千石撫子(花澤香菜)
  ['27931', '682354'], // SIX SHAME FACES ~今夜も最高!!!!!!~ / トト子(...) ↔ トト子 feat....
  ['27948', '687699'], // Stay Alive / 高橋李依 ↔ エミリア (CV : 高橋李依)
  ['27952', '687133'], // SAKURAスキップ / Fourfolium ↔ fourfolium ...
  ['27962', '156842'], // 好きな人がいること / JY(知英) ↔ JY
  ['27991', '688892'], // Wishing / 水瀬いのり ↔ レム (CV:水瀬いのり)
  ['28652', '671090'], // 太陽のFlare Sherbet / 久保田未夢 ↔ そふぃ(cv.久保田未夢)
  ['28740', '696488'], // STEP by STEP UP / Fourfolium ↔ fourfolium ...
  ['28786', '423155'], // にめんせい☆ ウラオモテライフ! / 田中あいみ ↔ 土間うまる(CV:田中あいみ)
  ['28802', '689913'], // 旅立ちのうた / 3年E組うた担 ↔ 3年E組
  ['28991', '685194'], // EZ DO DANCE -K.O.P. REMIX- / 増田俊樹,武内駿輔 ↔ 仁科カヅキ vs ...
  ['52786', '443607'], // メイド・イン・トキメキ♪ / Ra*bits ↔ Ra*bits(...)
  ['52787', '692333'], // Neo Sanctuary / fine ↔ fine(...)
  ['52921', '637875'], // BLOOM / TWS(Feat.Ayumu Imazu) ↔ BLOOM (feat. Ayumu Imazu) / TWS
  ['68021', '425517'], // ルナティックDEStiNy / 蒼井翔太 ↔ 如月ルヰ (CV.蒼井翔太)
  ['68042', '439823'], // チカっとチカ千花っ / 小原好美 ↔ 藤原千花(CV.小原好美)
  ['68097', '441786'], // マッチョアネーム? / 石川界人 ↔ 街雄鳴造(CV:石川界人)
  ['68134', '444504'], // イントゥ・ジ・アンノウン ~心のままに / 松たか子,オーロラ ↔ イントゥ・ジ・アンノウン～心のままに / 松たか子(エルサ)(feat. オーロラ)
  ['68142', '444804'], // 魔法の川の子守唄 / 吉田羊 ↔ 吉田羊(イドゥナ王妃)
  ['68143', '444810'], // わたしにできること / 神田沙也加 ↔ 神田沙也加(アナ)
  ['68153', '444919'], // 1・2・3 / After the Rain ↔ After the Rain [そらる×まふまふ]
  ['68250', '448615'], // WHITE GRAVITY / WHITE GRAVITY ↔ WHITE GRAVITY[...]
  ['68265', '448749'], // Ready to / 諸星すみれ ↔ 影森みちる (CV:諸星すみれ)
  ['68310', '314362'], // 約束の絆 / 妖夢討伐隊 ↔ 妖夢討伐隊 ...
  ['68322', '486984'], // 灰色のサーガ / ChouCho ↔ ChouCho(ちょうちょ)
  ['68340', '486983'], // 快眠！安眠！スヤリスト生活 / 水瀬いのり ↔ スヤリス姫(CV.水瀬いのり)
  ['68382', '443457'], // サニードロップ / 山下七海 ↔ 大槻唯(CV:山下七海)
  ['68384', '488132'], // うやむや(YouTube Ver.) / SixTONES ↔ うやむや / SixTONES
  ['68443', '693032'], // イシュカン・コミュニケーション / ちょろゴンず ↔ ちょろゴンず(...)
  ['68474', '819429'], // In Hell We Live, Lament / Mili(Feat.KIHOW) ↔ In Hell We Live，Lament《本人映像》 / Mili (R1 tier-A batch2 2026-07-05)
  ['68576', '493580'], // I Believe / 狩野翔 ↔ 松野千冬(CV:狩野翔)
  ['68734', '493581'], // Rest In Rampage / 水中雅章 ↔ 場地圭介(CV:水中雅章)
  ['68825', '618291'], // サインはＢ -アイ Solo Ver.- / Ｂ小町アイ ↔ B小町 アイ (CV:高橋李依)
  ['68889', '487547'], // Life Is Beautiful / The Cat's Whiskers ↔ Life Is Beautiful / The Cat's Whiskers
  ['68890', '487548'], // FRE△KOUT / BAE ↔ FRE△KOUT / BAE
  // --- R1 B-tier review batch (2026-07-05, 6-agent web review: rename/kanji/romaji/VA-credit) ---
  ['25232', '14786'], // tj-25232: char-VA 横山智佐=真宮寺さくら+帝国歌劇団
  ['25302', '11899'], // tj-25302: kanji typo 井出泰影=井出泰彰
  ['25364', '57888'], // tj-25364: romaji Trio matic=とりおまてぃっく
  ['25554', '14631'], // tj-25554: kanji 松澤由実=松澤由美
  ['25834', '61720'], // tj-25834: romaji スクービードゥー=Scoobie Do
  ['25869', '32579'], // tj-25869: rename 関ジャニ∞=SUPER EIGHT
  ['25905', '39031'], // tj-25905: VA-expand エンジェル隊
  ['26037', '10276'], // tj-26037: rename 関ジャニ∞=SUPER EIGHT (コント tag)
  ['26169', '20299'], // tj-26169: rename ENDLICHERI☆ENDLICHERI=ENDRECHERI
  ['26171', '55886'], // tj-26171: group 関智一外7人=最白-トレブラン-
  ['26187', '10699'], // tj-26187: rename 関ジャニ∞=SUPER EIGHT
  ['26204', '21123'], // tj-26204: rename 関ジャニ∞=SUPER EIGHT
  ['26210', '21099'], // tj-26210: rename ENDLICHERI=ENDRECHERI
  ['26253', '126158'], // tj-26253: romaji ナイトメア=NIGHTMARE
  ['26292', '126679'], // tj-26292: romaji ナイトメア=NIGHTMARE
  ['26352', '23469'], // tj-26352: rename ENDLICHERI=ENDRECHERI
  ['26376', '10823'], // tj-26376: romaji The Baby Stars=ザ・ベイビースターズ
  ['26407', '123586'], // tj-26407: char-VA 渋谷有利(櫻井孝宏), 桜井=櫻井
  ['26442', '24538'], // tj-26442: rename 関ジャニ∞=SUPER EIGHT
  ['26543', '163339'], // tj-26543: romaji ナイトメア=NIGHTMARE
  ['26616', '14062'], // tj-26616: kanji 花澤加繪=花沢加絵
  ['26666', '25722'], // tj-26666: rename 関ジャニ∞=SUPER EIGHT
  ['26908', '91142'], // tj-26908: same 桜高軽音部 (K-ON!)
  ['27002', '91908'], // tj-27002: rename 関ジャニ∞=SUPER EIGHT
  ['27074', '92724'], // tj-27074: rename 関ジャニ∞=SUPER EIGHT
  ['27142', '93032'], // tj-27142: rename 関ジャニ∞=SUPER EIGHT
  ['27180', '94466'], // tj-27180: rename 関ジャニ∞=SUPER EIGHT
  ['27185', '94522'], // tj-27185: rename 関ジャニ∞=SUPER EIGHT (マイホーム)
  ['27195', '94629'], // tj-27195: rename 関ジャニ∞=SUPER EIGHT
  ['27216', '28989'], // tj-27216: rename 関ジャニ∞=SUPER EIGHT
  ['27274', '94467'], // tj-27274: rename 関ジャニ∞=SUPER EIGHT
  ['27323', '197255'], // tj-27323: rename 関ジャニ∞=SUPER EIGHT
  ['27336', '147662'], // tj-27336: MUCC=ムック
  ['27351', '31429'], // tj-27351: rename 関ジャニ∞=SUPER EIGHT
  ['27435', '32989'], // tj-27435: rename 関ジャニ∞=SUPER EIGHT
  ['27446', '119059'], // tj-27446: rename 関ジャニ∞=SUPER EIGHT
  ['27491', '58627'], // tj-27491: kanji typo 石原洵子=石原詢子
  ['27531', '20748'], // tj-27531: rename 関ジャニ∞=SUPER EIGHT
  ['27589', '731111'], // tj-27589: char-VA 阿良々木月火(井口裕香)
  ['27598', '119659'], // tj-27598: rename 関ジャニ∞=SUPER EIGHT
  ['27633', '101672'], // tj-27633: μ's=ラブライブ! franchise credit
  ['27673', '119908'], // tj-27673: rename 関ジャニ∞=SUPER EIGHT
  ['27882', '174548'], // tj-27882: kanji 朴璐美=朴路美 char-VA
  ['28450', '146870'], // tj-28450: VA-expand 765PRO ALLSTARS
  ['28949', '684973'], // tj-28949: KING OF PRISM movie CV cast
  ['28998', '424125'], // tj-28998: 315 STARS unit-expand
  ['52800', '613071'], // tj-52800: romaji DAZBEE=ダズビー
  ['6151', '2337'], // tj-6151: 李 成愛=李成愛(イ・ソンエ)
  ['6191', '353'], // tj-6191: duo 五木ひろし/木の実ナナ connector
  ['6247', '3438'], // tj-6247: kanji 森繁久彌=森繁久弥
  ['6289', '2459'], // tj-6289: romaji バブルガムブラザーズ=Bubble Gum Brothers
  ['6298', '12593'], // tj-6298: kanji 松坂晶子=松阪晶子
  ['6322', '2349'], // tj-6322: 李 成愛=李成愛(イ・ソンエ)
  ['6323', '1447'], // tj-6323: 李 成愛=李成愛(イ・ソンエ)
  ['6379', '27017'], // tj-6379: kanji 鶴岡雅儀=鶴岡雅義
  ['6464', '27004'], // tj-6464: kanji 新川二朗=新川二郎
  ['6505', '27174'], // tj-6505: kanji 菊池章子=菊地章子
  ['6560', '4184'], // tj-6560: kanji 澤田=沢田知可子
  ['6654', '1410'], // tj-6654: kanji 眞木=真木由布子
  ['6679', '2120'], // tj-6679: kanji 箱崎晋一朗=箱崎晋一郎
  ['6685', '1638'], // tj-6685: kanji 長澤薰=長沢薫 (duo order)
  ['6695', '13184'], // tj-6695: kanji 黑澤=黒沢年男
  ['6723', '915'], // tj-6723: kanji 寺尾聰=寺尾聡
  ['6760', '60223'], // tj-6760: romaji ザ・ブロード・サイド・フォー=THE BROADSIDE FOUR
  ['68170', '446013'], // tj-68170: char-VA expand (アイマス)
  ['68171', '444966'], // tj-68171: VA-expand Bad Ass Temple (ヒプマイ)
  ['6822', '20980'], // tj-6822: 安室奈美惠=奈美恵 feat IMAJIN
  ['6828', '2520'], // tj-6828: kanji typo 安部里律子=安倍理津子
  ['6864', '20847'], // tj-6864: センチメンタル・バス=SENTIMENTAL BUS
  ['6896', '14763'], // tj-6896: romaji Pocket Biscuits=ポケットビスケッツ
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const REVIEWED_TIER_E_JOYS_BY_TJ = new Map<string, Set<string>>();
for (const [tj, joysound] of REVIEWED_TIER_E_STRONG_PAIRS) {
  const existing = REVIEWED_TIER_E_JOYS_BY_TJ.get(tj);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_E_JOYS_BY_TJ.set(tj, new Set([joysound]));
}

const EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT = 164;
const REVIEWED_TIER_E_FORBIDDEN_PAIRS = new Set([
  '26121|65623',
  '26121|77873',
  '26121|78108',
  '26121|78109',
  '26121|78110',
  '26121|78111',
  '26750|168779',
  '28852|631988',
  '68183|683200',
  '68258|445312',
  '68290|731408',
]);

function assertReviewedTierEPairInvariant(): void {
  if (REVIEWED_TIER_E_STRONG_PAIRS.length !== EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT) {
    throw new Error(
      `Tier E reviewed-strong allowlist must contain exactly ${EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT} pairs`,
    );
  }

  const pairs = new Set<string>();
  const tjs = new Set<string>();
  const joys = new Set<string>();
  for (const [tj, joysound] of REVIEWED_TIER_E_STRONG_PAIRS) {
    const pairKey = `${tj}|${joysound}`;
    if (pairs.has(pairKey)) throw new Error(`Tier E duplicate reviewed pair: ${pairKey}`);
    if (tjs.has(tj)) throw new Error(`Tier E duplicate TJ number in reviewed pairs: ${tj}`);
    if (joys.has(joysound))
      throw new Error(`Tier E duplicate JOYSOUND number in reviewed pairs: ${joysound}`);
    if (REVIEWED_TIER_E_FORBIDDEN_PAIRS.has(pairKey)) {
      throw new Error(`Tier E forbidden non-strong pair present in allowlist: ${pairKey}`);
    }
    pairs.add(pairKey);
    tjs.add(tj);
    joys.add(joysound);
  }
}

assertReviewedTierEPairInvariant();

/**
 * Tier F is a post-crawl residual split-pair allowlist derived from the
 * 2026-06-15 full JOYSOUND detail/ruby audit. Unlike Tier E, these pairs are
 * not all raw official `tj` ↔ `joysound` singletons: some are blog/tjpdf rows
 * that carry only a TJ/KY number and pair to a JOYSOUND-bearing row. Therefore
 * the deployable surface is still exact pair-level evidence, not a broad
 * artist-alias or title-only rule.
 *
 * Inclusion rules used to generate this first slice:
 * - broad audit bucket `proposed_strong` only;
 * - one best candidate, no same-provider conflict, unique target/JOY numbers;
 * - recomputed evidence is artist exact, target artist contained in candidate
 *   credit, or artist_ko exact with no collab/paren punctuation on either
 *   primary artist;
 * - explicitly excluded: feature-artist Korean-name leakage, short numeric
 *   artist tokens (`19` ↔ `19(ジューク)`), and the existing Tier E
 *   reviewed-but-not-strong pairs whose raw tieup/credit evidence is not
 *   retained in `SongRecord`.
 */
const REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS = [
  ['tj', '52784', '634289'], // うつくしい世界('出光興産' CM) / Aimer ↔ うつくしい世界 / Aimer
  ['tj', '28636', '166838'], // コスって!オーマイハニー / 平野綾 ↔ コスって!オーマイハニー / こなたとパティ(平野綾とささきのぞみ)
  ['ky', '44158', '689337'], // No title / Reol ↔ No title / れをる
  ['tj', '25041', '21879'], // LOVE 2000 / 安室奈美惠 ↔ LOVE 2000 / 安室奈美恵
  ['tj', '25048', '26759'], // 君のためにできること / Gackt ↔ 君のためにできること / GACKT(Gackt)
  ['tj', '25087', '20220'], // Mizerable / Gackt ↔ Mizerable / GACKT(Gackt)
  ['tj', '25107', '24986'], // U+K / Gackt ↔ U+K / GACKT(Gackt)
  ['tj', '25169', '22448'], // I WILL / 安室奈美惠 ↔ I WILL / 安室奈美恵
  ['tj', '25170', '11837'], // Another World / Gackt ↔ ANOTHER WORLD / GACKT(Gackt)
  ['tj', '25203', '26563'], // Think of me / 安室奈美惠 ↔ think of me / 安室奈美恵
  ['tj', '25208', '22704'], // 忘れないから / Gackt ↔ 忘れないから / GACKT(Gackt)
  ['tj', '25211', '26331'], // Secret Garden / Gackt ↔ Secret Garden / GACKT(Gackt)
  ['tj', '25214', '24085'], // Mirror / Gackt ↔ Mirror / GACKT(Gackt)
  ['tj', '25321', '14283'], // SWEET 19 BLUES / 安室奈美惠 ↔ SWEET 19 BLUES / 安室奈美恵
  ['tj', '25358', '9148'], // 太陽のSEASON / 安室奈美惠 ↔ 太陽のSEASON / 安室奈美恵
  ['tj', '25427', '9678'], // Chase the Chance / 安室奈美惠 ↔ Chase the Chance / 安室奈美恵
  ['tj', '25486', '24125'], // OASIS / Gackt ↔ OASIS / GACKT(Gackt)
  ['tj', '25515', '28526'], // shine more / 安室奈美惠 ↔ shine more / 安室奈美恵
  ['tj', '25520', '28590'], // 君が追いかけた夢 / Gackt ↔ 君が追いかけた夢 / GACKT(Gackt)
  ['tj', '25572', '28873'], // 月の詩 / Gackt ↔ 月の詩 / GACKT(Gackt)
  ['tj', '25637', '31857'], // SO CRAZY / 安室奈美惠 ↔ SO CRAZY / 安室奈美恵
  ['tj', '25656', '31959'], // Last Song / Gackt ↔ Last Song / GACKT(Gackt)
  ['tj', '25703', '22108'], // sha la la / Skoop On Somebody ↔ sha la la / Skoop On Somebody(SKOOP)
  ['tj', '25763', '36540'], // MARIA / Gackt ↔ Maria / GACKT(Gackt)
  ['tj', '25772', '30774'], // ALARM / 安室奈美惠 ↔ ALARM / 安室奈美恵
  ['tj', '25823', '58967'], // 暁の車(機動戦士ガンダムSEED) / Fiction Junction YUUKA ↔ 暁の車 / FictionJunction YUUKA
  ['tj', '25828', '32720'], // ALL FOR YOU / 安室奈美惠 ↔ ALL FOR YOU / 安室奈美恵
  ['tj', '25872', '71446'], // トイレットペッパーマン / SMAP ↔ トイレットペッパーマン / 中居正広(SMAP)
  ['tj', '25875', '10140'], // ロボキッス / ダブルユー ↔ ロボキッス / W(ダブルユー)
  ['tj', '25885', '10155'], // 君に逢いたくて / Gackt ↔ 君に逢いたくて / GACKT(Gackt)
  ['tj', '25983', '10756'], // Want me, want me / 安室奈美惠 ↔ WANT ME，WANT ME / 安室奈美恵
  ['tj', '25994', '17857'], // 愛の意味を教えて! / ダブルユー ↔ 愛の意味を教えて! / W(ダブルユー)
  ['tj', '26002', '9369'], // STOP THE MUSIC / 安室奈美惠 ↔ Stop the music / 安室奈美恵
  ['tj', '26113', '28630'], // Meteor―ミーティア―(機動戦士ガンダムSEED) / T.M.Revolution ↔ Meteor -ミーティア- / T.M.Revolution
  ['tj', '26117', '33867'], // Asrun Dream / Gackt ↔ Asrun Dream / GACKT(Gackt)
  ['tj', '26124', '18958'], // White Light / 安室奈美惠 ↔ White Light / 安室奈美恵
  ['tj', '26265', '59538'], // ヒトリジメ / GUMI ↔ ヒトリジメ / グミ
  ['tj', '26284', '52119'], // INDIGO BLUE LOVE / モーニング娘。 ↔ INDIGO BLUE LOVE / 新垣/田中/亀井(モーニング娘。)
  ['tj', '26351', '36777'], // 鋼の魂(スーパーロボットスピリッツ CM) / 水木一郎,影山ヒロノブ ↔ 鋼の魂 / 水木一郎/影山ヒロノブ
  ['tj', '26353', '23614'], // 君に贈る歌 / 小池徹平 ↔ 君に贈る歌 / 小池徹平(WaT)
  ['tj', '26419', '51537'], // Emotion(機動戦士ガンダムSEED Character Song) / 田中理恵 ↔ EMOTION / 田中理恵(ミーア・キャンベル)
  ['tj', '26439', '24536'], // FUNKY TOWN / 安室奈美惠 ↔ FUNKY TOWN / 安室奈美恵
  ['tj', '26593', '701067'], // Stay Gold / Hi-STANDARD ↔ STAY GOLD《本人映像》 / Hi-STANDARD
  ['tj', '26630', '164853'], // 君がくれたあの日 / 茅原美里 ↔ 君がくれたあの日 / 茅原実里
  ['tj', '26689', '168322'], // みくみくにしてあげる / 初音ミク ↔ みくみくにしてあげる♪ / ika_mo feat.初音ミク
  ['tj', '26755', '27477'], // WHAT A FEELING / 安室奈美惠 ↔ WHAT A FEELING / 安室奈美恵
  ['tj', '26852', '27845'], // Sexy Girl / 安室奈美惠 ↔ Sexy Girl / 安室奈美恵
  ['tj', '26897', '90344'], // WILD / 安室奈美惠 ↔ WILD / 安室奈美恵
  ['tj', '26903', '138428'], // 炉心融解 / 鏡音リン ↔ 炉心融解 / iroha(sasaki) feat.鏡音リン
  ['tj', '27004', '138537'], // 火葬曲 / 初音ミク ↔ 火葬曲 / No.D/上野悠仁 feat.初音ミク
  ['tj', '27029', '137780'], // Magnet / 初音ミク, 巡音ルカ ↔ magnet / minato(流星P) feat.初音ミク、巡音ルカ
  ['tj', '27035', '313880'], // 天樂 / 鏡音リン ↔ 天樂 / ゆうゆ feat.鏡音リン
  ['tj', '27225', '28994'], // Fighters / 三代目 J Soul Brothers ↔ FIGHTERS / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27246', '29443'], // リフレイン / 三代目 J Soul Brothers ↔ リフレイン / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27289', '106500'], // ハッピーシンセサイザ / 巡音ルカ,GUMI ↔ ハッピーシンセサイザ / EasyPop feat.巡音ルカ、GUMI
  ['tj', '27353', '31344'], // 花火 / 三代目 J Soul Brothers ↔ 花火 / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27441', '32984'], // SPARK / 三代目 J Soul Brothers ↔ SPARK / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27512', '119208'], // くまモンもん / 森高千里 ↔ くまモンもん / くまモン[うた:森高千里]
  ['tj', '27736', '736117'], // 居酒屋「津軽」 / 大石まどか ↔ 居酒屋「津軽」 / 大石まどか(大石 円)
  ['tj', '27930', '119568'], // R.Y.U.S.E.I. / 三代目 J Soul Brothers ↔ R.Y.U.S.E.I. / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '28829', '698687'], // 四季折々に揺蕩いて / After the Rain ↔ 四季折々に揺蕩いて / After the Rain [そらる×まふまふ]
  ['tj', '28902', '174857'], // 卑怯戦隊うろたんだー / KAITO ↔ 卑怯戦隊うろたんだー / シンP feat.KAITO、MEIKO、初音ミク
  ['tj', '52418', '805808'], // 失礼しますが、RIP▽ / Mori Calliope ↔ 失礼しますが、RIP《本人映像》 / Mori Calliope
  ['tj', '52817', '629460'], // Keep on Moving ( 'アクエリアス'CM) / NEXZ ↔ Keep on Moving / NEXZ
  ['tj', '52869', '434866'], // Hello, Morning / KizunaAI ↔ Hello，Morning / KizunaAI(キズナアイ)
  ['tj', '52883', '635245'], // かもね / KizunaAI ↔ かもね / KizunaAI(キズナアイ)
  ['tj', '52970', '692552'], // 明日も('NTTドコモ' CM) / SHISHAMO ↔ 明日も / SHISHAMO
  ['tj', '6136', '2811'], // 悲しみのゆくえ / チョーヨンピル ↔ 悲しみのゆくえ / 趙容弼(チョー・ヨンピル)
  ['tj', '6194', '2840'], // 想いで迷子 / チョーヨンピル ↔ 想いで迷子 / 趙容弼(チョー・ヨンピル)
  ['tj', '6234', '2078'], // 涙の朝 / 八代亞紀 ↔ 涙の朝 / 八代亜紀
  ['tj', '6319', '2768'], // 私について / 工藤靜香 ↔ 私について / 工藤静香
  ['tj', '6320', '111441'], // 大田ブルース / 李 成愛 ↔ 大田ブルース / 李成愛(イ・ソンエ)
  ['tj', '6324', '2331'], // 離別(イビョル) / 李 成愛 ↔ 離別(イビョル) / 李成愛(イ・ソンエ)
  ['tj', '6334', '1898'], // 愛の共犯者 / チョーヨンピル ↔ 愛の共犯者 / 趙容弼(チョー・ヨンピル)
  ['tj', '6449', '27150'], // 蘇州夜曲 / 渡辺はま子 ↔ 蘇州夜曲 / 渡辺はま子/霧島昇
  ['tj', '6611', '2879'], // 出で湯橋 / 大川英策 ↔ 出で湯橋 / 大川栄策
  ['tj', '6633', '27068'], // さよならはダンスの後に / 倍賞千惠子 ↔ さよならはダンスの後に / 倍賞千恵子
  ['tj', '6653', '1391'], // 熱いさよなら / 五輪眞弓 ↔ 熱いさよなら / 五輪真弓
  ['tj', '6751', '27008'], // 下町の太陽 / 倍賞千惠子 ↔ 下町の太陽 / 倍賞千恵子
  ['tj', '6752', '1890'], // 紅い落葉 / チョーヨンピル ↔ 紅い落葉 / 趙容弼(チョー・ヨンピル)
  ['tj', '6778', '17094'], // 球 根 / Yellow Monkey ↔ 球根 / THE YELLOW MONKEY
  ['tj', '68628', '431052'], // 快感*エブリディ / B-PROJECT ↔ 快感*エブリディ / B-PROJECT[キタコレ・THRIVE・MooNs・KiLLER KiNG]
  ['tj', '68705', '610059'], // うらたねこ♀ / うらたぬき ↔ うらたねこ♀ / うらたぬき(浦島坂田船)
  ['tj', '68764', '492851'], // ワタシノミカタ / 夏川椎菜(Feat.HoneyWorks) ↔ ワタシノミカタ / mona(CV:夏川椎菜) feat. HoneyWorks
  ['tj', '6878', '19877'], // RESPECT the POWER OF LOVE / 安室奈美惠 ↔ RESPECT the POWER OF LOVE / 安室奈美恵
  ['tj', '6922', '17408'], // Nostalgia / 相川七瀨 ↔ Nostalgia / 相川七瀬
  ['tj', '6942', '24985'], // NEVER END / 安室奈美惠 ↔ NEVER END / 安室奈美恵
  ['tj', '6963', '18086'], // in the sky / 工藤靜香 ↔ in the sky / 工藤静香
  ['tj', '27542', '196477'], // 優しさの理由 / ChouCho ↔ 優しさの理由 / ChouCho(ちょうちょ)
  ['tj', '27874', '178358'], // 守るべきもの / 國分優香里 ↔ 守るべきもの / 沢田綱吉(國分優香里)
  ['tj', '27890', '166465'], // スキ?キライ!?スキ!!! / 釘宮理恵 ↔ スキ? キライ!? スキ!!! / ルイズ(釘宮理恵)
  ['tj', '28004', '71040'], // 1st Priority / メロキュア ↔ 1st Priority / メロキュア(岡崎律子/日向めぐみ)
  ['tj', '28048', '94825'], // Episode.0 / Gackt ↔ Episode.0 / GACKT(Gackt)
  ['tj', '28067', '136421'], // Heart Goes Boom!! / 日笠陽子 ↔ Heart Goes Boom!! / 秋山澪(日笠陽子)
  ['tj', '28070', '168186'], // Help Me, ERINNNNNN!! / ビートまりお ↔ Help me，ERINNNNNN!! / ビートまりお(COOL&CREATE)
  ['tj', '28088', '109803'], // Love Marginal / Printemps ↔ Love marginal / Printemps ～高坂穂乃果(新田恵海)、南ことり(内田彩)、小泉花陽(久保ユリカ) from μ's～
  ['tj', '28115', '20003'], // Redemption / Gackt ↔ REDEMPTION / GACKT(Gackt)
  ['tj', '28119', '138614'], // Ring My Bell / blue drops ↔ Ring My Bell / blue drops(吉田仁美&イカロス(早見沙織))
  ['tj', '28123', '125615'], // Select? / 茅原実里 ↔ SELECT? / 長門有希(茅原実里)
  ['tj', '28148', '139260'], // Treasure / 碧陽学園生徒会 ↔ Treasure / 碧陽学園生徒会(本多真梨子/斉藤佑圭/富樫美鈴/堀中優希)
  ['tj', '28151', '137949'], // Under Mebius / 茅原実里 ↔ under“Mebius” / 長門有希(茅原実里)
  ['tj', '28176', '722675'], // アイドル活動 / STAR☆ANIS ↔ アイドル活動! / わか・ふうり・すなお from STAR☆ANIS
  ['tj', '28179', '138579'], // エージェント夜を往く / 平田宏美 ↔ エージェント夜を往く / 菊地真(平田宏美)
  ['tj', '28184', '110810'], // オリオンで Shout Out / 谷山紀章 ↔ オリオンでSHOUT OUT / 四ノ宮那月(谷山紀章)
  ['tj', '28194', '731219'], // キミが光であるために / 小野賢章 ↔ キミが光であるために / 黒子テツヤ(CV.小野賢章)
  ['tj', '28201', '169339'], // クフフのフ~僕と契約~ / 飯田利信 ↔ クフフのフ ～僕と契約～ / 六道 骸(飯田利信)
  ['tj', '28250', '171544'], // ひとりぼっちの運命 / 近藤隆 ↔ ひとりぼっちの運命 / 雲雀恭弥(近藤隆)
  ['tj', '28253', '173631'], // ファミリー~約束の場所~ / 國分優香里 Withボンゴレファミリー ↔ ファミリー ～約束の場所～ / 沢田綱吉(國分優香里) with ボンゴレファミリー(ニーコ・市瀬秀和・井上優・木内秀信・近藤隆・飯田利信・竹内順子・津田健次郎・稲村優奈・吉田仁美・チャン・リーメイ)
  ['tj', '28268', '162483'], // まっがーれ↓スペクタクル / 小野大輔 ↔ まっがーれ↓スペクタクル / 古泉一樹(小野大輔)
  ['tj', '28281', '738026'], // ラブノベルス / BiBi ↔ ラブノベルス / BiBi ～絢瀬絵里(南條愛乃)、西木野真姫(Pile)、矢澤にこ(徳井青空) from μ's～
  ['tj', '28308', '669102'], // 冬がくれた予感 / BiBi ↔ 冬がくれた予感 / BiBi ～絢瀬絵里(南條愛乃)、西木野真姫(Pile)、矢澤にこ(徳井青空) from μ's～
  ['tj', '28315', '313909'], // 恋のヒメヒメぺったんこ / 田村ゆかり ↔ 恋のヒメヒメぺったんこ / 姫野湖鳥 (cv.田村ゆかり)
  ['tj', '28316', '723689'], // 恋は渾沌の隷也 / 後ろから這いより隊G ↔ 恋は渾沌の隷也 / 後ろから這いより隊G(ニャル子×クー子×珠緒)
  ['tj', '28320', '136364'], // 林檎もぎれビーム! / 大槻ケンヂと絶望少女達 ↔ 林檎もぎれビーム! / 大槻ケンヂと絶望少女達(風浦可符香、木津千里、木村カエレ、関内・マリア・太郎、日塔奈美)
  ['tj', '28347', '91884'], // 雪月花~The End Of Silence~ / Gackt ↔ 雪月花 -The end of silence- / GACKT(Gackt)
  ['tj', '28357', '60776'], // 水の証 / 田中理恵 ↔ 水の証 / 田中理恵(ラクス・クライン)
  ['tj', '28376', '198159'], // 月に叢雲華に風 / 幽閉サテライト ↔ 月に叢雲華に風 / 幽閉サテライト/senya
  ['tj', '28398', '162045'], // 天壌を翔る者たち / Love Planet Five ↔ 天壌を翔る者たち / Love Planet Five(I've special unit)
  ['tj', '28400', '670792'], // 青春サツバツ論 / 3年E組うた担 ↔ 青春サツバツ論 / 3年E組うた担 (渚&茅野&業&磯貝&前原)
  ['tj', '28406', '111543'], // 七色のコンパス / 宮野真守 ↔ 七色のコンパス / 一ノ瀬トキヤ(宮野真守)
  ['tj', '28407', '167106'], // 寝・逃・げでリセット! / 福原香織 ↔ 寝・逃・げでリセット! / 柊つかさ(福原香織)
  ['tj', '28409', '197839'], // 太陽曰く燃えよカオス / 後ろから這いより隊G ↔ 太陽曰く燃えよカオス / 後ろから這いより隊G(ニャル子×クー子×珠緒)
  ['tj', '28415', '736438'], // 回レ!雪月花 / 歌組雪月花 ↔ 回レ!雪月花 / 歌組雪月花 夜々 (CV 原田ひとみ) いろり (CV 茅野愛衣) 小紫 (CV 小倉唯)
  ['tj', '28421', '677993'], // かくしん的めたまるふぉ~ぜっ / 田中あいみ ↔ かくしん的☆めたまるふぉ～ぜっ! / 土間うまる(CV:田中あいみ)
  ['tj', '28460', '22254'], // ミニハムずの愛の唄 / ミニモニ。 ↔ ミニハムずの愛の唄 / ミニハムず(ミニモニ。)
  ['tj', '28518', '171072'], // 炎神戦隊ゴーオンジャー / 高橋秀幸 ↔ 炎神戦隊ゴーオンジャー / 高橋秀幸(Project.R)
  ['tj', '28577', '127980'], // 帰り道 / 加藤英美里 ↔ 帰り道 / 八九寺真宵(加藤英美里)
  ['tj', '28634', '76837'], // Fields of hope / 田中理恵 ↔ Fields of hope / 田中理恵(ラクス・クライン)
  ['tj', '28643', '173546'], // 無限回廊 / 田村ゆかり ↔ 無限回廊 / 古手梨花(田村ゆかり)
  ['tj', '28685', '693440'], // アンチクロックワイズ / After the Rain ↔ アンチクロックワイズ / After the Rain [そらる×まふまふ]
  ['tj', '28722', '693441'], // 解読不能 / After the Rain ↔ 解読不能 / After the Rain [そらる×まふまふ]
  ['tj', '28723', '692651'], // Los! Los! Los! / 悠木碧 ↔ Los! Los! Los! / ターニャ・デグレチャフ(CV:悠木碧)
  ['tj', '28796', '176015'], // 隣に... / たかはし智秋 ↔ 隣に・・・ / 三浦あずさ(たかはし智秋)
  ['tj', '28969', '136105'], // 蒼い鳥 / 今井麻美 ↔ 蒼い鳥 / 如月千早(今井麻美)
  ['tj', '68053', '430430'], // レッドナイト・ヴァンパイア / 武内駿輔,八代拓,内田雄馬 ↔ レッドナイト・ヴァンパイア / 大和アレクサンダー、十王院カケル、涼野ユウ(cv.武内駿輔、八代拓、内田雄馬)
  ['tj', '68064', '685969'], // nth color / 宍戸留美 ↔ nth color / 天羽ジュネ cv. 宍戸留美
  ['tj', '68082', '430428'], // Starved For You / 蒼井翔太,武内駿輔 ↔ Starved For You / 如月ルヰ、大和アレクサンダー(cv.蒼井翔太、武内駿輔)
  ['tj', '68262', '680296'], // 秘密のトワレ / 藍原ことみ ↔ 秘密のトワレ / 一ノ瀬志希(CV 藍原ことみ)
  // --- R1 audit batch (2026-07-02 owner-reviewed missing-JOYSOUND residuals) ---
  // Single-vendor TJ/KY-only target rows paired to a JOYSOUND-bearing candidate.
  // Both-vendor targets (`blog-1184-1/-3`, `blog-487-11`) and candidates that
  // carry their own conflicting TJ number (`tj-25103↔tj-6579`,
  // `tj-27098↔blog-523-9`) are outside this mechanism and were left out.
  ['tj', '28113', '110661'], // Ready!! / 765PRO ALLSTARS ↔ READY!!(M@STER VERSION) / 765PRO ALLSTARS
  ['tj', '28127', '100139'], // Shiver / ガゼット ↔ SHIVER / the GazettE
  ['tj', '28456', '7687'], // ペガサス幻想 / MAKE-UP ↔ ペガサス幻想(ファンタジー) / MAKE-UP
  ['tj', '28513', '24891'], // 深紅 / 島谷ひとみ ↔ 深紅(original version) / 島谷ひとみ
  ['tj', '28603', '733701'], // snowdrop(春奈るな Ver.) / 春奈るな ↔ snowdrop / 春奈るな
  ['tj', '68007', '57864'], // wind / Akeboshi ↔ wind(ワインド) / Akeboshi
  ['tj', '68342', '487541'], // 再会 / LiSA,Uru(produced by Ayase) ↔ 再会 (produced by Ayase) / LiSA
  // --- R1 audit batch 2 (2026-07-05 tier-A web-review) ---
  ['tj', '28511', '15420'], // 2人 / ともさか りえ ↔ 2人(ふたり) / ともさかりえ (tjpdf-28511)
  ['tj', '68746', '147267'], // とても痛い痛がりたい(カバー) / EZFG(Feat.灯油) ↔ とても痛い痛がりたい / EZFG (tjpdf-68746)
  ['tj', '28478', '22844'], // 勇気100% / Ya-Ya-yah ↔ 勇気100%〈2002〉 / Ya-Ya-yah (tjpdf-28478, R1 tier-A batch2)
  // --- R1 B-tier review batch (2026-07-05, 6-agent web review) — tjpdf single-vendor targets ---
  ['tj', '27866', '175340'], // tjpdf-27866: romaji ナイトメア=NIGHTMARE
  ['tj', '28042', '167103'], // tjpdf-28042: romaji ナイトメア=NIGHTMARE
  ['tj', '28225', '135171'], // tjpdf-28225: 藤咲かりん=miko (IOSYS)
  ['tj', '28389', '163185'], // tjpdf-28389: romaji マキシマムザホルモン=Maximum The Hormone
  ['tj', '28516', '13847'], // tjpdf-28516: ささきいさお=佐々木功
  ['tj', '28637', '177103'], // tjpdf-28637: romaji ナイトメア=NIGHTMARE
  ['tj', '28930', '431014'], // tjpdf-28930: typo 摩天狼=麻天狼 (ヒプマイ)
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT = 155;
const REVIEWED_TIER_F_FORBIDDEN_PAIRS = [
  ['tj', '28895', '441874'], // MISIA feat. HIDE(GReeeeN) matched to GReeeeN-only artist_ko donor
  ['tj', '25022', '11802'], // short numeric artist 19 requires manual review
  ['tj', '6927', '19868'], // short numeric artist 19 requires manual review
  ['tj', '6935', '21182'], // short numeric artist 19 requires manual review
  ['tj', '26750', '168779'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68183', '683200'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68258', '445312'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68290', '731408'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

export const REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS = new Map<
  string,
  Partial<Record<NonJoysoundVendor, string>>
>([
  // `No title` / Reol: the KY-only target attaches to a row that already has
  // the reviewed TJ↔JOY merge (`tj-28704` + JOY 689337). This is an explicit
  // triple, not a general permission to import arbitrary JOY-side TJ/KY cells.
  [reviewedTierFPairKey('ky', '44158', '689337'), { tj: '28704' }],
  // R1 batch: `再会` / LiSA — the TJ-only target (`tj-68342`) pairs to a blog
  // row (`blog-153-179`) that already carries a reviewed KY number (`44631`)
  // alongside the JOY number (`487541`). Explicit triple, not a general
  // permission to import arbitrary JOY-side TJ/KY cells.
  [reviewedTierFPairKey('tj', '68342', '487541'), { ky: '44631' }],
]);

export function reviewedTierFPairKey(
  vendor: NonJoysoundVendor,
  number: string,
  joysound: string,
): string {
  return `${vendor}|${number}|${joysound}`;
}

export const REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER = new Map<string, Set<string>>();
for (const [vendor, number, joysound] of REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS) {
  const key = `${vendor}:${number}`;
  const existing = REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER.get(key);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER.set(key, new Set([joysound]));
}

function assertReviewedTierFPairInvariant(): void {
  if (
    REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS.length !==
    EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT
  ) {
    throw new Error(
      `Tier F post-crawl allowlist must contain exactly ${EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT} pairs`,
    );
  }

  const pairs = new Set<string>();
  const vendorNumbers = new Set<string>();
  const joys = new Set<string>();
  const forbidden = new Set(
    REVIEWED_TIER_F_FORBIDDEN_PAIRS.map(([vendor, number, joysound]) =>
      reviewedTierFPairKey(vendor, number, joysound),
    ),
  );
  for (const [vendor, number, joysound] of REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS) {
    const pairKey = reviewedTierFPairKey(vendor, number, joysound);
    const vendorNumberKey = `${vendor}:${number}`;
    if (pairs.has(pairKey)) throw new Error(`Tier F duplicate reviewed pair: ${pairKey}`);
    if (vendorNumbers.has(vendorNumberKey))
      throw new Error(`Tier F duplicate target provider number: ${vendorNumberKey}`);
    if (joys.has(joysound)) throw new Error(`Tier F duplicate JOYSOUND number: ${joysound}`);
    if (forbidden.has(pairKey)) {
      throw new Error(`Tier F forbidden non-strong pair present in allowlist: ${pairKey}`);
    }
    pairs.add(pairKey);
    vendorNumbers.add(vendorNumberKey);
    joys.add(joysound);
  }
}

assertReviewedTierFPairInvariant();
