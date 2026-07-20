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
  // --- R1 reject-set audit (2026-07-05): artistId false-rejects recovered (JP/EN name, rename, char-VA, romaji) ---
  ['25543', '21147'], // tj-25543: グミ=日向めぐみ (debut stage name); Catch You Catch Me
  ['25857', '53433'], // tj-25857: char-VA 越前リョーマ(皆川純子); RISING
  ['25988', '67500'], // tj-25988: manzo=萬Ｚ(量産型) latin/kanji
  ['26577', '35176'], // tj-26577: fictional band BAD LUCK=コタニキンヤ
  ['26754', '164310'], // tj-26754: char SUN(瀬戸燦)=桃井はるこ
  ['27316', '915749'], // tj-27316: rename 安倍里葎子→安倍理津子
  ['27317', '199621'], // tj-27317: rename 安倍里葎子→安倍理津子
  ['27520', '14096'], // tj-27520: romaji RATS&STAR=ラッツ&スター (夢で逢えたら)
  ['52758', '1006'], // tj-52758: romaji RATS&STAR=ラッツ&スター (め組のひと)
  ['6646', '2683'], // tj-6646: ザ・ドリフターズ=ドリフターズ (The- prefix)
  ['68188', '685066'], // tj-68188: CV=character split (アイマス)
  ['68285', '485792'], // tj-68285: CV=character split (BanG Dream)
  ['68292', '485111'], // tj-68292: CV=character split
  ['68772', '438536'], // tj-68772: romaji KizunaAI=キズナアイ feat 中田ヤスタカ
  // --- R1 C-tier review (2026-07-05): title-rendering recoveries (kyūjitai / romaji↔kana / subtitle / tag) ---
  ['25369', '14947'], // tj-25369: romaji Ultra Relax=ウルトラ リラックス
  ['25761', '37498'], // tj-25761: ハッスルマッスル=HUSTLE MUSCLE
  ['28005', '680953'], // tj-28005: SIX SAME FACES 今夜も/は最高 (も/は typo, base ver)
  ['28165', '28419'], // tj-28165: アドバンス・アドベンチャー (=～Advance Adventure～ subtitle)
  ['28891', '426706'], // tj-28891: Viator=ウィアートル (romaji↔katakana, Maquia theme)
  ['52879', '146104'], // tj-52879: ミラクルショッピング=Miracle Shopping
  ['6144', '634427'], // tj-6144: 酔っぱらっちゃった → 酔っぱらっちゃった2025 (re-recording)
  ['6166', '107742'], // tj-6166: 靑春時代=青春時代 (kyūjitai; reformed-lineup credit)
  ['6422', '240'], // tj-6422: 小麥ちゃん=小麦ちゃん ～それからの麦畑～ (kyūjitai+subtitle)
  ['6659', '19047'], // tj-6659: 雨の夜あなたは歸る=帰る (kyūjitai)
  ['6827', '719'], // tj-6827: 會津の小鐵=会津の小鉄 (kyūjitai)
  ['68380', '488127'], // tj-68380: ALMIGHTY～仮面の約束 feat.川上洋平 (OST tag; full ver)
  ['6861', '16877'], // tj-6861: スタミナ=STAMINA (katakana↔romaji)
  // --- 2026-07-10 owner-adjudicated version-ambiguous batch (R1 follow-up) ---
  // DORMANT until a JOYSOUND-bearing compose: no joysound-source rows exist in
  // the weekly blog+tj baseline, so these merges take effect only at the next
  // JOYSOUND-crawl corpus.
  ['26271', '166525'], // STILL(咎狗の血 ED) / いとう かなこ ↔ STILL〈日本語Version〉 / いとう かなこ (JP-language version; same artist/title)
  ['27017', '175060'], // BLACK DIAMOND(しゅごキャラ! OST) / ブラックダイヤモンズ ↔ BLACK DIAMOND〈Major Version〉 / ブラックダイヤモンズ (owner: major cut over indies joy176052)
  ['52426', '806868'], // ねねねねねねねね! 大爆走 / 桃鈴ねね ↔ ねねねねねねねね! 大爆走〈レコ音〉 / 桃鈴ねね (owner: reco-oto cut over honnin-eizou joy809290)
  ['26411', '166164'], // 氷のエンペラーII / Various Artists ↔ 氷のエンペラーII / ミュージカル テニスの王子様 (title-only merge; TJ VA placeholder)
  ['26827', '172354'], // F・G・K・S / Various Artists ↔ F・G・K・S / ミュージカル テニスの王子様 (title-only; only 2 DB results)
  // --- Audit follow-up B (2026-07-16 manual merge review of residual
  // joyless-record audit candidates, 16 review batches). Effective at the
  // next JOYSOUND-crawl corpus (v24 re-merge). ---
  ['25065', '26141'], // tj-25065 Simply Wonderful / 倉木麻衣 ↔ Simply Wonderful〈Club Edit〉 / 倉木麻衣
  ['25152', '55428'], // tj-25152 Soldier of fortune / Loudness ↔ SOLDIER OF FORTUNE / ラウドネス
  ['25519', '28527'], // tj-25519 real Emotion(FINAL FANTASY X-2) / 倖田來未 ↔ real Emotion / 倖田來未
  ['25985', '17703'], // tj-25985 叙情詩 / L'Arc~en~Ciel ↔ 叙情詩(ジョジョウシ) / L'Arc-en-Ciel
  ['26057', '3635'], // tj-26057 都会の天使たち / 堀内孝雄,桂銀淑 ↔ 都会の天使たち / 桂銀淑/堀内孝雄
  ['26070', '78175'], // tj-26070 撲殺天使ドクロちゃん(撲殺天使ドクロちゃん OP) / 千葉紗子 ↔ 撲殺天使ドクロちゃん / ドクロちゃん(千葉紗子)
  ['26224', '21461'], // tj-26224 宙船 / TOKIO ↔ 宙船(そらふね) / TOKIO
  ['26436', '23743'], // tj-26436 蕾(ドラマ'東京タワー 〜オカンとボクと、時々、オトン〜'OST) / コブクロ ↔ 蕾(つぼみ) / コブクロ
  ['26714', '167088'], // tj-26714 魔理沙は大変なものを 盗んでいきました / 藤咲かりん(miko) ↔ 魔理沙は大変なものを盗んでいきました / イオシス/藤咲かりん
  ['26927', '1081'], // tj-26927 済州エア･ポート / 半田浩二 ↔ 済州エア・ポート(チェジュエアポート) / 半田浩二
  ['27795', '139899'], // tj-27795 サンドリヨン / シグナルP(Feat.初音ミク,KAITO) ↔ サンドリヨン(Cendrillon) / Dios/シグナルP feat.初音ミク、KAITO
  ['27932', '684141'], // tj-27932 バイバイ YESTERDAY(暗殺教室 OP) / 3年E組うた担 ↔ バイバイ YESTERDAY / 3年E組うた担 (渚&茅野&業&磯貝&前原)
  ['28112', '75264'], // tj-28112 Ready Go!(ポケットモンスター OP) / 田村直美 ↔ Ready Go!(レディーゴー) / 田村直美
  ['28763', '674317'], // tj-28763 自力本願レボリューション(暗殺教室 OP) / 3年E組うた担 ↔ 自力本願レボリューション / 3年E組うた担 (渚&茅野&業&磯貝&前原)
  ['28914', '432059'], // tj-28914 ミッション! 健・康・第・イチ(はたらく細胞 OP) / 花澤香菜,前野智昭,小野大輔,井上喜久子 ↔ ミッション! 健・康・第・イチ / 赤血球(CV:花澤香菜) 白血球(CV:前野智昭) キラーT細胞(CV:小野大輔) マクロファージ(CV:井上喜久子)
  ['52747', '630725'], // tj-52747 POP IN 2(TVアニメ '推しの子' OST) / B小町 ↔ POP IN 2 / B小町 ルビー(CV:伊駒ゆりえ) 有馬かな(CV:潘めぐみ) MEMちょ(CV:大久保瑠美)
  ['52750', '493916'], // tj-52750 初心LOVE(ドラマ '消えた初恋' OST) / なにわ男子 ↔ 初心LOVE(うぶらぶ) / なにわ男子
  ['68076', '441787'], // tj-68076 お願いマッスル(ダンベル何キロ持てる? OP) / ファイルーズあい,石川界人 ↔ お願いマッスル / 紗倉ひびき(CV:ファイルーズあい)、街雄鳴造(CV:石川界人)
  ['68222', '425626'], // tj-68222 絶対よい子のエトセトラ / After the Rain ↔ 絶対よい子のエトセトラ / After the Rain [そらる×まふまふ]
  ['68305', '486586'], // tj-68305 なんどでも笑おう(THE IDOLM@STER OST) / THE IDOLM@STER FIVE STARS!!!!! ↔ なんどでも笑おう / THE IDOLM@STER FIVE STARS!!!!!
  ['68515', '492286'], // tj-68515 星の旅人(かげきしょうじょ！！ ED) / 千本木彩花,花守ゆみり ↔ 星の旅人 / 渡辺さらさ(CV.千本木彩花) × 奈良田愛(CV.花守ゆみり)
  ['68524', '491303'], // tj-68524 ABC体操(うらみちお兄さん OP) / 宮野真守,水樹奈々 ↔ ABC体操 / いけてるお兄さん (CV:宮野真守) うたのお姉さん (CV:水樹奈々)
  ['68583', '424812'], // tj-68583 More One Night(少女終末旅行 ED) / 水瀬いのり,久保ユリカ ↔ More One Night / チト(CV:水瀬いのり)、ユーリ(CV:久保ユリカ)
  ['68930', '497330'], // tj-68930 Alive / Full Throttle4(Feat.HoneyWorks) ↔ Alive / Full Throttle4 (Vo:斉藤壮馬・内田雄馬) feat. HoneyWorks
  // --- Audit follow-up B, both-vendor tail (2026-07-20). The 46 reviewed MERGE
  // rows whose target carries BOTH tj+ky vendor numbers under a non-tj id-slug
  // (ky-/tjpdf-/blog-). #163 left these unencodable ("both-vendor, non-tj id"):
  // the reviewed tiers then needed a tj id-slug (Tier E) or a single-vendor
  // target (Tier F). #165 removed that guard, so a Tier E [tj, joysound] pair
  // now fires by matching the tj vendor-number cell regardless of id-slug,
  // gated only by the cluster vendor-number conflict guard. Derived by
  // scripts/encode-b-wave-merge-pairs.mjs. Effective at the next
  // JOYSOUND-crawl corpus (v24+ re-merge). ---
  ['26310', '21930'], // ky-42263 この世の限り(錯乱 OST) / 椎名林檎,椎名純平 ↔ この世の限り / 椎名林檎×斎藤ネコ+椎名純平
  ['26525', '163385'], // ky-42453 もってけ!セーラーふく(らき☆すた OP) / 平野綾 ↔ もってけ!セーラーふく / 泉こなた(平野綾)、柊かがみ(加藤英美里)、柊つかさ(福原香織)、高良みゆき(遠藤綾)
  ['26749', '91145'], // ky-42670 メルト / 初音ミク ↔ メルト / supercell
  ['26865', '177033'], // ky-42833 ブラック★ ロックシューター / 初音ミク ↔ ブラック★ロックシューター / supercell
  ['26906', '178844'], // ky-43058 悪ノ娘 / mothy_悪ノP(Feat.鏡音リン) ↔ 悪ノ娘 / mothy feat.鏡音リン
  ['26963', '137288'], // ky-43128 止マレ!(涼宮ハルヒの憂鬱 ED) / 平野綾・茅原美里・後藤邑子 ↔ 止マレ! / 涼宮ハルヒ(CV.平野綾)、長門有希(CV.茅原実里)、朝比奈みくる(CV.後藤邑子)
  ['27030', '136579'], // ky-43113 ロミオとシンデレラ / 初音ミク ↔ ロミオとシンデレラ / doriko
  ['27031', '138844'], // ky-43185 ルカルカ★ナイトフィーバー / 巡音ルカ ↔ ルカルカ★ナイトフィーバー / samfree
  ['27347', '31314'], // ky-43519 0 Game(アメイジング・スパイダーマン OST) / SPYAIR ↔ 0 GAME(ラブゲーム) / SPYAIR
  ['27670', '725112'], // ky-43644 ロストワンの号哭 / 鏡音リン ↔ ロストワンの号哭 / Neru
  ['27703', '128519'], // ky-44001 虹色の戦争 / SEKAI NO OWARI ↔ 虹色の戦争 / 世界の終わり
  ['27757', '93423'], // ky-44021 天使と悪魔(霊能力者小田霧響子の嘘 OST) / SEKAI NO OWARI ↔ 天使と悪魔 / 世界の終わり
  ['27768', '128343'], // ky-43971 幻の命 / SEKAI NO OWARI ↔ 幻の命 / 世界の終わり
  ['28002', '670815'], // blog-1184-3 &Z / 澤野弘之 ↔ &Z / SawanoHiroyuki[nZk]:mizuki
  ['28007', '316353'], // ky-43845 aLIEz / 澤野弘之 ↔ aLIEz / SawanoHiroyuki[nZk]:mizuki
  ['28052', '162961'], // ky-42503 First Good-Bye / 平野綾 ↔ First Good-Bye / 涼宮ハルヒ(C.V.平野綾)
  ['28056', '138451'], // tjpdf-28056 Funny Sunny Day / SxOxU ↔ Funny Sunny Day〈Japanese Version〉 / SxOxU
  ['28062', '156116'], // tjpdf-28062 Great Distance / ryo(supercell)(F eat.chelly) ↔ Great Distance / supercell
  ['28098', '94502'], // ky-43358 Os-宇宙人 / 神聖かまってちゃん ↔ Os-宇宙人 / エリオをかまってちゃん
  ['28132', '100546'], // tjpdf-28132 Someone Else / 阿澄佳奈,藤田咲,喜多村英梨 ↔ SOMEONE ELSE / 種島ぽぷら(阿澄佳奈)・伊波まひる(藤田咲)・轟八千代(喜多村英梨)
  ['28189', '165114'], // ky-42649 かえして!ニーソックス / 平野綾 ↔ かえして!ニーソックス / 泉こなた(平野綾)、柊かがみ(加藤英美里)、柊つかさ(福原香織)、高良みゆき(遠藤綾)
  ['28193', '136422'], // tjpdf-28193 ギー太に首ったけ / 豊崎愛生 ↔ ギー太に首ったけ / 平沢唯(豊崎愛生)
  ['28217', '726244'], // tjpdf-28217 ススメ→トゥモロウ / 新田恵海,内田彩,三森すずこ ↔ ススメ→トゥモロウ / 高坂穂乃果(CV.新田恵海)南ことり(CV.内田彩)園田海未(CV.三森すずこ)
  ['28230', '721971'], // tjpdf-28230 ドラマチックマーケットライド / 洲崎綾 ↔ ドラマチックマーケットライド / 北白川たまこ(cv:洲崎綾)
  ['28231', '166422'], // ky-42576 どんだけファンファーレ / 平野綾 ↔ どんだけファンファーレ / 泉こなた(平野綾)
  ['28234', '103142'], // tjpdf-28234 ハートの確率 / blue drops ↔ ハートの確率(Main Vocal Hitomi) / blue drops(吉田仁美&イカロス(早見沙織))
  ['28238', '100624'], // tjpdf-28238 はっぴぃにゅうにゃあ / 伊藤かな恵,井口裕香,竹達彩奈 ↔ はっぴぃ にゅう にゃあ / 芹沢文乃(伊藤かな恵)&梅ノ森千世(井口裕香)&霧谷希(竹達彩奈)
  ['28244', '124976'], // ky-42686 パラレルDays / 平野綾 ↔ パラレルDays / 涼宮ハルヒ(C.V.平野綾)
  ['28257', '176434'], // tjpdf-28257 プレパレード / 釘宮理恵,堀江由衣,喜多村英梨 ↔ プレパレード / 逢坂大河(釘宮理恵)・櫛枝実乃梨(堀江由衣)・川嶋亜美(喜多村英梨)
  ['28270', '198862'], // tjpdf-28270 まどろみの約束 / 佐藤聡美,茅野愛衣 ↔ まどろみの約束 / 千反田える(佐藤聡美)&伊原摩耶花(茅野愛衣)
  ['28287', '136931'], // tjpdf-28287 わたしの恋はホッチキス / 放課後ティータイム ↔ わたしの恋はホッチキス〈唯&澪MainVo.〉 / 放課後ティータイム
  ['28292', '168428'], // tjpdf-28292 経験値上昇中☆ / 佐藤利奈,井上麻里奈,茅原実里 ↔ 経験値上昇中☆ / 南春香(佐藤利奈)/南夏奈(井上麻里奈)/南千秋(茅原実里)
  ['28336', '163662'], // tjpdf-28336 僕らのLove Style / 鈴村健一,藤田圭宣 ↔ 僕らのLove Style / 常陸院光・馨(鈴村健一・藤田圭宣)
  ['28371', '171198'], // tjpdf-28371 俺達のJOY! / 市瀬秀和 vs 井上優 ↔ 俺達のJOY! / 獄寺隼人(市瀬秀和) vs 山本武(井上優)
  ['28384', '116266'], // tjpdf-28384 残念系隣人部★★☆ / 友達つくり隊 ↔ 残念系隣人部★★☆(星二つ半) / 友達つくり隊
  ['28394', '737474'], // tjpdf-28394 地獄の沙汰も君次第 / 地獄の沙汰オールスターズ ↔ 地獄の沙汰も君次第 / 地獄の沙汰オールスターズ(鬼灯CV:安元洋貴/閻魔大王CV:長嶝高士/シロCV:小林由美子/唐瓜CV:柿原徹也/茄子CV:青山桐子/お香CV:喜多村英梨/YOUR SONG IS GOOD)
  ['28404', '170533'], // ky-42730 最強パレパレード / 平野綾 ↔ 最強パレパレード / 涼宮ハルヒ(CV.平野綾)、長門有希(CV.茅原実里)、朝比奈みくる(CV.後藤邑子)
  ['28724', '670058'], // ky-44171 アマテラス / 上北健 ↔ アマテラス / KK
  ['28735', '678172'], // ky-44179 ミスト / KK(上北健) ↔ ミスト / 上北健
  ['28736', '423053'], // ky-44181 砂の惑星 / ハチ(Feat.初音ミク) ↔ 砂の惑星 ( + 初音ミク ) / 米津玄師
  ['28744', '723196'], // ky-44186 アストロノーツ / 椎名もた ↔ アストロノーツ / ぽわぽわP feat.初音ミク
  ['68297', '197394'], // blog-1149-23 こいかぜ(アイドルマスターシンデレラガールズスターライトステージ OST) / 早見沙織 ↔ こいかぜ / 高垣楓(CV早見沙織)
  ['68314', '738747'], // ky-44598 聖槍爆裂ボーイ / れるりり,もじゃ(大柴広己)(Feat.鏡音レン) ↔ 聖槍爆裂ボーイ / れるりり/もじゃ feat.鏡音レン
  ['68356', '435281'], // ky-44627 眠れる森に行きたいな(ラブライブ！スクールアイドルフェスティバル ALL STAR OST) / 鬼頭明里 ↔ 眠れる森に行きたいな / 近江彼方(CV.鬼頭明里)
  ['68728', '493602'], // tjpdf-68728 Ghosts / 土岐隼一 ↔ Ghosts / 羽宮一虎(CV:土岐隼一)
  ['68835', '617946'], // ky-44962 Magic('コカ・コーラ' TVCM) / Mrs. GREEN APPLE ↔ Magic / Mrs. GREEN APPLE
  // --- 2026-07-20 owner adjudication (forbidden-release). Five pairs moved out
  // of REVIEWED_TIER_E_FORBIDDEN_PAIRS after the B-wave web review satisfied
  // each prior hold. Lines emitted verbatim by
  // scripts/encode-b-wave-merge-pairs.mjs. Effective at the next JOYSOUND-crawl
  // corpus (v24+ re-merge). See docs/ROADMAP.md. ---
  ['6927', '19868'], // tj-6927 あの紙ヒコーキ くもり空わって / 19 ↔ あの紙ヒコーキ くもり空わって / 19(ジューク)
  ['6935', '21182'], // tj-6935 すべてへ / 19 ↔ すべてへ / 19(ジューク)
  ['26121', '65623'], // tj-26121 ハッピー☆マテリアル(魔法先生 ネギま! OP) / 麻帆良学園中等部2-A ↔ ハッピー☆マテリアル / 麻帆良学園中等部2-A(相坂さよ/明石裕奈/朝倉和美/綾瀬夕映/和泉亜子/大河内アキラ)
  ['26750', '168779'], // tj-26750 空想ルンバ(懺・さよなら絶望先生 OP) / 大槻ケンヂと絶望少女達 ↔ 空想ルンバ / 大槻ケンヂと絶望少女達(風浦可符香、木津千里、木村カエレ、関内・マリア・太郎、日塔奈美)
  ['68258', '445312'], // tj-68258 ファンサ(告白実行委員会 ~恋愛シリーズ~ OST) / 夏川椎菜 ↔ ファンサ / mona(CV:夏川椎菜)
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const REVIEWED_TIER_E_JOYS_BY_TJ = new Map<string, Set<string>>();
for (const [tj, joysound] of REVIEWED_TIER_E_STRONG_PAIRS) {
  const existing = REVIEWED_TIER_E_JOYS_BY_TJ.get(tj);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_E_JOYS_BY_TJ.set(tj, new Set([joysound]));
}

const EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT = 271;
const REVIEWED_TIER_E_FORBIDDEN_PAIRS = new Set([
  // 2026-07-20 owner adjudication RELEASED 26121|65623, 26750|168779,
  // 68183|683200, 68258|445312, 68290|731408 — the B-wave web confirmation
  // satisfied each prior hold, so they move into the reviewed-strong allowlist
  // (see the 2026-07-20 owner-adjudication section below and docs/ROADMAP.md).
  // Still held: the ハッピー☆マテリアル multi-JOYSOUND variants (one TJ number,
  // several month-specific JOYSOUND cuts — no single strong target) and the
  // FLOW X GRANRODEO ↔ XG short-token false positive.
  '26121|77873',
  '26121|78108',
  '26121|78109',
  '26121|78110',
  '26121|78111',
  '28852|631988',
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
  // --- R1 C-tier review (2026-07-05): tjpdf title-rendering recoveries ---
  ['tj', '27864', '171476'], // tjpdf-27864: リンゴ日和 truncation (～The Wolf Whistling Song～)
  ['tj', '28212', '731713'], // tjpdf-28212: ジョジョ～その血の運命(さだめ)～ reading gloss
  ['tj', '28213', '671697'], // tjpdf-28213: ジョジョ その血の記憶 truncation (～end of THE WORLD～)
  ['tj', '29906', '5407'], // tjpdf-29906: 風の谷のナウシカ (Korean prefix junk in TJ title)
  ['tj', '29910', '59651'], // tjpdf-29910: I,I,You&愛=I，I，You&I (愛=ai pun)
  ['tj', '68430', '489807'], // tjpdf-68430: ぐだふわエブリデー (garbled anime-tag prefix)
  // --- Audit follow-up B (2026-07-16 manual merge review of residual
  // joyless-record audit candidates, 16 review batches). Effective at the
  // next JOYSOUND-crawl corpus (v24 re-merge). ---
  ['ky', '40138', '2238'], // ky-40138 明日の詩 / 杉良太郞 ↔ 明日の詩 / 杉良太郎
  ['ky', '40151', '2531'], // ky-40151 命くれない / 瀬川瑛子 ↔ 命くれない / 瀨川瑛子
  ['ky', '40158', '18796'], // ky-40158 Two As One / Crystal Kay x CHEMISTRY ↔ Two As One / Crystal Kay×CHEMISTRY
  ['ky', '40203', '1495'], // ky-40203 おまえとおれ / 杉良太郞 ↔ おまえとおれ / 杉良太郎
  ['ky', '40214', '195'], // ky-40214 川 / 北島三郞 ↔ 川 / 北島三郎
  ['ky', '40222', '39956'], // ky-40222 片恋酒 / 宮史郞 ↔ 片恋酒 / 宮史郎
  ['ky', '40230', '2628'], // ky-40230 北の漁場 / 北島三郞 ↔ 北の漁場 / 北島三郎
  ['ky', '40288', '27054'], // ky-40288 新宿そだち / 津山洋子、大木英夫 ↔ 新宿そだち / 大木英夫,津山洋子
  ['ky', '40314', '2621'], // ky-40314 そんな夕子にほれました / 増位山太志郞 ↔ そんな夕子にほれました / 増位山太志郎
  ['ky', '40318', '857'], // ky-40318 そんな女のひとりごと / 増位山太志郞 ↔ そんな女のひとりごと / 増位山太志郎
  ['ky', '40327', '70'], // ky-40327 旅鴉 / 五木ひろし ↔ 旅鴉(たびがらす) / 五木ひろし
  ['ky', '40363', '1800'], // ky-40363 夏の終りのハーモニー / 井上陽水 ↔ 夏の終りのハーモニー / 井上陽水/安全地帯
  ['ky', '40364', '27187'], // ky-40364 なみだ船 / 北島三郞 ↔ なみだ船 / 北島三郎
  ['ky', '40374', '995'], // ky-40374 暖簾 / 五木ひろし ↔ 暖簾(のれん) / 五木ひろし
  ['ky', '40390', '2669'], // ky-40390 歩 / 北島三郞 ↔ 歩 / 北島三郎
  ['ky', '40396', '2101'], // ky-40396 骨まで愛して / 城卓也 ↔ 骨まで愛して / 城 卓矢
  ['ky', '40405', '2726'], // ky-40405 まつり / 北島三郞 ↔ まつり / 北島三郎
  ['ky', '40417', '27190'], // ky-40417 柔 / 美空ひばり ↔ 柔(やわら) / 美空ひばり
  ['ky', '40425', '19012'], // ky-40425 湯の町エレジー / 近江俊郞 ↔ 湯の町エレジー / 近江俊郎
  ['ky', '40427', '2177'], // ky-40427 与作 / 北島三郞 ↔ 与作 / 北島三郎
  ['ky', '40465', '2532'], // ky-40465 女のみち / 宮史郞とぴんからトリオ ↔ 女のみち / 宮史郎とぴんからトリオ
  ['ky', '40475', '2239'], // ky-40475 すきま風 / 杉良太郞 ↔ すきま風 / 杉良太郎
  ['ky', '40500', '65347'], // ky-40500 青春狂騒曲 / Sambo Master ↔ 青春狂騒曲 / サンボマスター
  ['ky', '40528', '9874'], // ky-40528 日曜日よりの使者 / THE HIGH-LOWS ↔ 日曜日よりの使者 / ザ・ハイロウズ
  ['ky', '40613', '2553'], // ky-40613 神田川 / 南こうせつ ↔ 神田川 / かぐや姫
  ['ky', '40621', '2829'], // ky-40621 窓の外の女 / チョー・ヨンピル ↔ 窓の外の女 / 趙容弼(チョー・ヨンピル)
  ['ky', '40635', '2693'], // ky-40635 愛の讚歌 (IF YOU LOVE ME) / 越路吹雪 ↔ 愛の讚歌 / 越路吹雪
  ['ky', '40652', '2204'], // ky-40652 あの日にかえりたい / 荒井由実 ↔ あの日にかえりたい / 松任谷由実
  ['ky', '40663', '2142'], // ky-40663 男の背中 / 増位山太志郞 ↔ 男の背中 / 増位山太志郎
  ['ky', '40667', '2656'], // ky-40667 旅の終りに / 冠二郞 ↔ 旅の終りに / 冠 二郎
  ['ky', '40736', '9'], // ky-40736 女のねがい / 宮史郞とぴんから兄弟 ↔ 女のねがい / 宮史郎とぴんからトリオ
  ['ky', '40738', '27155'], // ky-40738 おんなの宿 / 大下八郞 ↔ おんなの宿 / 大下八郎
  ['ky', '40742', '3745'], // ky-40742 帰ろかな / 北島三郞 ↔ 帰ろかな / 北島三郎
  ['ky', '40767', '19136'], // ky-40767 銀座の雀 / 森繁久彌 ↔ 銀座の雀 / 森繁久弥
  ['ky', '40780', '19013'], // ky-40780 高原列車は行く / 岡本敦郞 ↔ 高原列車は行く / 岡本敦郎
  ['ky', '40793', '376'], // ky-40793 札幌ふたりづれ / 渕野忠明、都はるみ ↔ 札幌ふたりづれ / 都はるみ/渕野忠明
  ['ky', '40810', '1084'], // ky-40810 昭和枯れすすき / さくらと一郞 ↔ 昭和枯れすすき / さくらと一郎
  ['ky', '40814', '3437'], // ky-40814 白い花の咲く頃 / 岡本敦郞 ↔ 白い花の咲く頃 / 岡本敦郎
  ['ky', '40823', '2041'], // ky-40823 それは...黄昏 / 五木ひろし ↔ それは…黄昏(たそがれ) / 五木ひろし
  ['ky', '40832', '27070'], // ky-40832 ダンスパーティーの夜 / 林伊佐緖 ↔ ダンスパーティーの夜 / 林伊佐緒
  ['ky', '40837', '2671'], // ky-40837 私は泣いています / りりイ ↔ 私は泣いています / りりィ
  ['ky', '40846', '27063'], // ky-40846 東京流れもの / 竹越ひろこ ↔ 東京流れもの / 竹越ひろ子
  ['ky', '40847', '27156'], // ky-40847 東京のバスガール / コロムビアローズ ↔ 東京のバスガール / 初代コロムビア・ローズ
  ['ky', '40848', '2179'], // ky-40848 東京めぐり愛 / 石川さゆり、琴風豪規 ↔ 東京めぐり愛 / 琴風豪規,石川さゆり
  ['ky', '40856', '493'], // ky-40856 流されて / チョー・ヨンピル ↔ 流されて / 趙容弼(チョー・ヨンピル)
  ['ky', '40865', '3871'], // ky-40865 日本海 / 北島三郞 ↔ 日本海 / 北島三郎
  ['ky', '40867', '375'], // ky-40867 ぬれて大阪 / アローナイツ ↔ ぬれて大阪 / 秋庭豊とアローナイツ
  ['ky', '40871', '2213'], // ky-40871 年輪 / 北島三郞 ↔ 年 輪 / 北島三郎
  ['ky', '40878', '197'], // ky-40878 女性は愛に生きる / 三浦弘とハニーシックス ↔ 女性は愛に生きる(ひとはあいにいきる) / 三浦弘とハニー・シックス
  ['ky', '40882', '4056'], // ky-40882 二人の銀座 / 山内賢、和泉雅子 ↔ 二人の銀座 / 和泉雅子/山内賢
  ['ky', '40886', '1119'], // ky-40886 故郷 / 小林幸子 ↔ 故郷(ふるさと) / 小林幸子
  ['ky', '40901', '24'], // ky-40901 ミオ・ミオ・ミオ / チョー・ヨンピル ↔ ミオ・ミオ・ミオ / 趙容弼(チョー・ヨンピル)
  ['ky', '40902', '2185'], // ky-40902 岬めぐり / ウイークエンド ↔ 岬めぐり / ウィークエンド
  ['ky', '40911', '2032'], // ky-40911 霧笛が俺を呼んでいる / 赤木圭一郞 ↔ 霧笛が俺を呼んでいる / 赤木圭一郎
  ['ky', '40927', '2764'], // ky-40927 山 / 北島三郞 ↔ 山 / 北島三郎
  ['ky', '40928', '19011'], // ky-40928 山小舎の灯 / 近江俊郞 ↔ 山小舎の灯 / 近江俊郎
  ['ky', '40965', '4574'], // ky-40965 母影 / チョー・ヨンピル ↔ 母影 / 趙容弼(チョー・ヨンピル)
  ['ky', '40968', '3276'], // ky-40968 春告鳥 / キム・ヨンジャ ↔ 春告鳥(はるつげどり) / キム・ヨンジャ
  ['ky', '40979', '2399'], // ky-40979 未来女 / 桂銀淑 ↔ 未来女(みらいびと) / 桂銀淑
  ['ky', '40981', '2790'], // ky-40981 冬物語 / チョー・ヨンピル ↔ 冬物語 / 趙容弼(チョー・ヨンピル)
  ['ky', '40982', '2765'], // ky-40982 夢夜舟 / チョー・ヨンピル ↔ 夢夜舟 / 趙容弼(チョー・ヨンピル)
  ['ky', '41016', '24304'], // ky-41016 『果てのない道』 / 19 ↔ 『果てのない道』 / 19(ジューク)
  ['ky', '41058', '11637'], // ky-41058 チュッ! 夏パ~ティ / 3人祭 ↔ チュッ! 夏パ～ティ / 三人祭
  ['ky', '41060', '19090'], // ky-41060 新妻鏡 / 霧島昇 ↔ 新妻鏡 / 二葉あき子/霧島昇
  ['ky', '41084', '14816'], // ky-41084 CAN YOU CELEBRATE? / 安室奈美恵 ↔ Can you celebrate? / 安室奈美惠
  ['ky', '41096', '11690'], // ky-41096 いつも何度でも　("千と千尋の神隠し") / 木村弓 ↔ いつも何度でも / 木村弓
  ['ky', '41219', '16881'], // ky-41219 夢であるように ("Tales of Destiny") / DEEN ↔ 夢であるように / DEEN
  ['ky', '41220', '22575'], // ky-41220 Let's Get Together Now (JAPAN ver.) / Voices of KOREA/JAPAN ↔ Let's Get Together Now〈JAPAN Version〉 / Voices of KOREA/JAPAN
  ['ky', '41223', '35192'], // ky-41223 秋風の狂詩曲 / Raphael ↔ 秋風の狂詩曲 (ラプソディー) / Raphael
  ['ky', '41239', '12583'], // ky-41239 Blurry Eyes("D.N.A2") / L'Arc~en~Ciel ↔ BLURRY EYES(DNA2 OP) / L'Arc~en~Ciel
  ['ky', '41247', '2458'], // ky-41247 ウイスキーが、お好きでしょ / 石川さゆり ↔ ウイスキーが、お好きでしょ / SAYURI(石川さゆり)
  ['ky', '41249', '2438'], // ky-41249 銀座ブルース / 和田弘とマヒナスターズ、松尾和子 ↔ 銀座ブルース / 松尾和子/和田弘とマヒナスターズ
  ['ky', '41251', '27180'], // ky-41251 グッド・ナイト / 和田弘とマヒナスターズ、松尾和子 ↔ グッド・ナイト / 松尾和子/和田弘とマヒナスターズ
  ['ky', '41275', '27138'], // ky-41275 銀の指輪 / 石原裕次郎 ↔ 銀の指輪 / 石原裕次郎/愛まち子
  ['ky', '41277', '2644'], // ky-41277 今夜は離さない / 橋幸夫、安倍里律子 ↔ 今夜は離さない / 橋幸夫,安倍里葎子
  ['ky', '41294', '4036'], // ky-41294 サライ / 谷村新司、加山雄三 ↔ サライ / 加山雄三/谷村新司
  ['ky', '41346', '20409'], // ky-41346 終電 何時? / 山川豊、田川寿美 ↔ 終電 何時? / 田川寿美/山川豊
  ['ky', '41351', '5374'], // ky-41351 とんちんかんちん一休さん("一休さん") / 相内恵、ヤングフレッシュ ↔ とんちんかんちん一休さん / 相内恵,ヤングフレッシュ
  ['ky', '41375', '26356'], // ky-41375 flying ("Tales of Eternia") / GARNET CROW ↔ Flying(テイルズオブエターニア OP) / GARNET CROW
  ['ky', '41430', '18107'], // ky-41430 Like a star in the night ("ダーク・エンジェル") / 倉木麻衣 ↔ Like a star in the night / 倉木麻衣
  ['ky', '41561', '28400'], // ky-41561 雑走 / ROAD OF MAJOR ↔ 雑走 / ロードオブメジャー
  ['ky', '41693', '3089'], // ky-41693 河内おとこ節 / 中村美津子 ↔ 河内おとこ節 / 中村美律子
  ['ky', '41814', '10064'], // ky-41814 GIRL TALK / 安室奈美恵 ↔ GIRL TALK / 安室奈美惠
  ['ky', '41838', '24397'], // ky-41838 FOR REAL / 徳山秀典 ↔ For Real(幻想魔伝 最遊記 OP) / 德山秀典
  ['ky', '41854', '915190'], // ky-41854 Wishes / Le Couple ↔ Wishes〈Le Couple Version〉 / Le Couple(ル・クプル)
  ['ky', '41858', '14837'], // ky-41858 アニメタル / ANIMETAL ↔ アニメタル(アニメタル 主題歌) / アニメタル
  ['ky', '41909', '26250'], // ky-41909 橋 / 北島三郞 ↔ 橋 / 北島三郎
  ['ky', '41995', '18492'], // ky-41995 世界はそれを愛と呼ぶんだぜ / Sambo Master ↔ 世界はそれを愛と呼ぶんだぜ / サンボマスター
  ['ky', '42003', '18629'], // ky-42003 雪簾 / 神野美伽 ↔ 雪簾(ゆきすだれ) / 神野美伽
  ['ky', '42007', '20765'], // ky-42007 熊野古道 / 水森かおり ↔ 熊野古道(くまのこどう) / 水森かおり
  ['ky', '42082', '31761'], // ky-42082 本日ハ晴天ナリ ("Jリーグウィニングイレブンタクティス") / Do As Infinity ↔ 本日ハ晴天ナリ / Do As Infinity
  ['ky', '42085', '54486'], // ky-42085 アゲ♂アゲ♂EVERY☆騎士 / DJ OZMA ↔ アゲ♂アゲ♂EVERY☆騎士(ナイト) / DJ OZMA
  ['ky', '42121', '16730'], // ky-42121 幸せな結末 / 大滝詠一 ↔ 幸せな結末 / 大瀧詠一
  ['ky', '42158', '66411'], // ky-42158 貴女ノ為ノ此ノ命。 / ガゼット ↔ 貴女ノ為ノ此ノ命。 / the GazettE
  ['ky', '42159', '66418'], // ky-42159 別れ道 / ガゼット ↔ 別れ道 / the GazettE
  ['ky', '42205', '20816'], // ky-42205 GOLDFINGER'99 / 郷ひろみ ↔ GOLDFINGER'99 / 鄕ひろみ
  ['ky', '42242', '21883'], // ky-42242 関風ファイティング / 関ジャニ∞ ↔ 関風ファイティング / SUPER EIGHT
  ['ky', '42244', '21908'], // ky-42244 カリソメ乙女(DEATH JAZZ ver.) / 椎名林檎xSOIL& "PIMP" SESSIONS ↔ カリソメ乙女〈DEATH JAZZ ver.〉 / 椎名林檎
  ['ky', '42334', '10153'], // ky-42334 心絵 / ROAD OF MAJOR ↔ 心絵 / ロードオブメジャー
  ['ky', '42392', '161487'], // ky-42392 Climax Jump (特撮"仮面ライダー電王") / AAA DEN-O form ↔ Climax Jump / AAA DEN-O form
  ['ky', '42412', '14400'], // ky-42412 TAKE ME HIGHER (特撮"ウルトラマンティガ") / V6 ↔ TAKE ME HIGHER / V6
  ['ky', '42419', '24677'], // ky-42419 キッス~帰り道のラブソング~ ("ラブ★コン") / テゴマス ↔ キッス~帰り道の ラブソング~(ラブ★コン ED) / テゴマス
  ['ky', '42426', '67136'], // ky-42426 ベリーメロン ~私の心をつかんだ良いメロン~ / 若本規夫 ↔ ベリーメロン ～私の心をつかんだ良いメロン～ / ビクトリーム(若本規夫)
  ['ky', '42437', '11694'], // ky-42437 Spirit (特撮"ウルトラマンコスモス") / Project DMM ↔ Spirit / Project D.M.M.
  ['ky', '42444', '33314'], // ky-42444 My Heart言いだせない, Your Heart確かめたい / GODDESS FAMILY CLUB ↔ My Heart言いだせない，Your Heart確かめたい / GODDESS FAMILY CLUB(井上喜久子/冬馬由美/久川綾)
  ['ky', '42471', '65703'], // ky-42471 魔法戦隊マジレンジャー (特撮"魔法戦隊マジレンジャ-") / 岩崎貴文 ↔ 魔法戦隊マジレンジャー / 岩崎貴文
  ['ky', '42535', '56941'], // ky-42535 Double-Action (特撮"仮面ライダー電王") / 野上良太郎,モモタロス ↔ Double-Action / 野上良太郎&モモタロス(佐藤健・関俊彦)
  ['ky', '42536', '125287'], // ky-42536 雪、無音、窓辺にて。 / 茅原実里 ↔ 雪、無音、窓辺にて。 / 長門有希(茅原実里)
  ['ky', '42566', '25472'], // ky-42566 talkin' 2 myself / 浜崎あゆみ ↔ talkin' 2 myself〈Original mix〉 / 浜崎あゆみ
  ['ky', '42612', '167605'], // ky-42612 Sakura addiction / 雲雀恭弥+六道骸 ↔ Sakura addiction(家庭教師ヒットマンREBORN! ED) / 雲雀恭弥(近藤隆)vs六道骸(飯田利信)
  ['ky', '42614', '25824'], // ky-42614 青春(SEISYuN) / TOKIO ↔ 青春 / TOKIO
  ['ky', '42629', '27318'], // ky-42629 あなたがいる限り ~A WORLD TO BELIEVE IN~ / 伊藤由奈Xセリーヌ・ディオン ↔ あなたがいる限り ～A WORLD TO BELIEVE IN～ / 伊藤由奈×セリーヌ・ディオン
  ['ky', '42675', '27512'], // ky-42675 ワッハッハー / 関ジャニ∞ ↔ ワッハッハー / SUPER EIGHT
  ['ky', '42677', '27570'], // ky-42677 Kurikaesu 春 / 244 ENDLI-x ↔ Kurikaesu 春 / ENDRECHERI
  ['ky', '42709', '27500'], // ky-42709 吾亦紅 / 杉本眞人 ↔ 吾亦紅 / すぎもとまさと
  ['ky', '42723', '167703'], // ky-42723 GO MY WAY!! ("THE IDOLM@STER"OST) / 中村繪里子 ↔ GO MY WAY!! / 天海春香(CV:中村繪里子)
  ['ky', '42805', '65322'], // ky-42805 英雄 (特撮"ウルトラマンネクサス") / doa ↔ 英雄 / doa
  ['ky', '42861', '55329'], // ky-42861 恋のメガラバ / Maximum the Hormone ↔ 恋のメガラバ / マキシマム ザ ホルモン
  ['ky', '42900', '30095'], // ky-42900 LIGHT IN YOUR HEART (特撮"大決戦!超ウルトラ8兄弟") / V6 ↔ LIGHT IN YOUR HEART / V6
  ['ky', '42927', '69736'], // ky-42927 無責任ヒーロー / 関ジャニ∞ ↔ 無責任ヒーロー / SUPER EIGHT
  ['ky', '42941', '90305'], // ky-42941 Rule / 浜崎あゆみ ↔ Rule〈Original mix〉 / 浜崎あゆみ
  ['ky', '42967', '90346'], // ky-42967 Journey through the Decade (特撮"仮面ライダー ディケイド") / Gackt ↔ Journey through the Decade / GACKT(Gackt)
  ['ky', '42971', '90540'], // ky-42971 It's all Love! / 倖田來未Xmisono ↔ It's all Love! / 倖田來未×misono
  ['ky', '43142', '137186'], // ky-43142 ウォーアイニー / 高橋瞳xBEAT CRUSADERS ↔ ウォーアイニー(銀魂 ED) / 高橋瞳×BEAT CRUSADERS
  ['ky', '43160', '91653'], // ky-43160 急☆上☆Show!! / 関ジャニ∞ ↔ 急☆上☆Show!! / SUPER EIGHT
  ['ky', '43168', '138705'], // ky-43168 staple stable / 斎藤千和 ↔ Staple Stable / 戦場ヶ原ひたぎ(斎藤千和)
  ['ky', '43227', '128291'], // ky-43227 恋愛サーキュレーション / 花澤香菜 ↔ 恋愛サーキュレーション(化物語 OP) / 千石撫子(花澤香菜)
  ['ky', '43304', '93530'], // ky-43304 Anything Goes! (特撮"仮面ライダーオーズ") / 大黒摩季 ↔ Anything Goes!(仮面ライダー オーズ OP) / 大黒摩季
  ['ky', '43311', '100811'], // ky-43311 一番の宝物 / Girls Dead Monster ↔ 一番の宝物(Yui Ver.) / Girls Dead Monster
  ['ky', '43437', '94800'], // ky-43437 好きだよ。~100回の後悔~ / Sonar Pocket ↔ 好きだよ。 ~100回の後悔~ / ソナーポケット
  ['ky', '43466', '29281'], // ky-43466 365日のラブストーリー。 / Sonar Pocket ↔ 365日のラブストーリー。 / ソナーポケット
  ['ky', '43484', '30935'], // ky-43484 猛烈宇宙交響曲・第七楽章「無限の愛」(モーレツ宇宙海賊) / ももいろクローバーZ ↔ 猛烈宇宙交響曲・第七楽章「無限の愛」 / ももいろクローバーZ
  ['ky', '43553', '730913'], // ky-43553 Life is SHOW TIME (特撮"仮面ライダーウィザード") / 鬼龍院翔 from ゴールデンボンバー ↔ Life Is Show Time(仮面ライダーウィザード OP) / 鬼龍院翔 From ゴールデンボンバー
  ['ky', '43555', '731660'], // ky-43555 それはやっぱり君でした / 二宮和也(嵐) ↔ それはやっぱり君でした(Vocal:Kazunari Ninomiya) / 嵐
  ['ky', '43610', '723883'], // ky-43610 マジLOVE2000%("うたの☆プリンスさまっマジLOVE2000%") / ST☆RISH ↔ マジLOVE2000%(うたの☆プリンスさまっ♪マジLOVE2000％ ED) / ST☆RISH
  ['ky', '43795', '178607'], // ky-43795 Break+Your+Destiny / 遊佐浩二+中村悠一+谷山紀章 ↔ Break+Your+Destiny / 兵部京介 vs 皆本光一 with 賢木修二 starring 遊佐浩二+中村悠一+谷山紀章
  ['ky', '43914', '672838'], // ky-43914 夕映えプレゼント (アイドルマスターシンデレラガールズ) / CINDERELLA PROJECT ↔ 夕映えプレゼント / CINDERELLA PROJECT
  ['ky', '43924', '736002'], // ky-43924 Music S.T.A.R.T!! / u's ↔ Music S.T.A.R.T!! / μ's
  ['ky', '43934', '675367'], // ky-43934 Angelic Angel ("ラブライブ! The School Idol Movie") / u's ↔ Angelic Angel / μ's
  ['ky', '43943', '675365'], // ky-43943 僕たちはひとつの光 / u's ↔ 僕たちはひとつの光(ラブライブ! ED) / μ's
  ['ky', '43953', '315701'], // ky-43953 愛してるばんざーい! / u's ↔ 愛してるばんざーい! / μ's
  ['ky', '43965', '735581'], // ky-43965 M@STERPIECE("THE IDOLM@STER MOVIE 輝きの向こう側へ!") / 765PRO ALLSTARS ↔ M@STERPIECE / 765PRO ALLSTARS
  ['ky', '43967', '313280'], // ky-43967 Dancing stars on me! / u's ↔ Dancing stars on me!(ラブライブ! OST) / μ's
  ['ky', '43968', '678034'], // ky-43968 Raise your flag("機動戦士ガンダム 鉄血のオルフェンズ") / MAN WITH A MISSION ↔ Raise Your Flag(機動戦士ガンダム 鉄血のオルフェンズ OP) / MAN WITH A MISSION
  ['ky', '43992', '312570'], // ky-43992 KiRa-KiRa Sensation! / u's ↔ KiRa-KiRa Sensation!(ラブライブ! OST) / μ's
  ['ky', '44004', '675366'], // ky-44004 SUNNY DAY SONG / u's ↔ Sunny Day Song(劇場版 ラブライブ! The School Idol Movie OST) / μ's
  ['ky', '44013', '312250'], // ky-44013 ユメノトビラ / u's ↔ ユメノトビラ / μ's
  ['ky', '44025', '682362'], // ky-44025 MOMENT RING / u's ↔ Moment Ring(ラブライブ! OST) / μ's
  ['ky', '44054', '722785'], // ky-44054 きっと青春が聞こえる / u's ↔ きっと青春が聞こえる / μ's
  ['ky', '44059', '684469'], // ky-44059 恋になりたいAQUARIUM ("ラブライブ! サンシャイン!!") / Aqours ↔ 恋になりたい AQUARIUM(ラブライブ!サンシャイン!! OST) / Aqours
  ['ky', '44062', '156704'], // ky-44062 越後水原 / 水森かおり ↔ 越後水原(すいばら) / 水森かおり
  ['ky', '44076', '678050'], // ky-44076 君のこころは輝いてるかい? ("ラブライブ! サンシャイン") / Aqours ↔ 君のこころは 輝いてるかい?(ラブライブ!サンシャイン!! OST) / Aqours
  ['ky', '44077', '686491'], // ky-44077 chase ("ジョジョの奇妙な冒険 ダイヤモンドは砕けない") / batta ↔ Chase / batta
  ['ky', '44215', '691428'], // ky-44215 EXCITE (特撮"仮面ライダーエグゼイド") / 三浦大知 ↔ EXCITE / 三浦大知
  ['ky', '44240', '698956'], // ky-44240 未来の僕らは知ってるよ (ラブライブ! サンシャイン!!) / Aqours ↔ 未来の僕らは知ってるよ(ラブライブ!サンシャイン!! OP) / Aqours
  ['ky', '44282', '425240'], // ky-44282 日曜日の秘密 (ずっと前から好きでした。告白実行委員会) / HoneyWorks meets CHiCO & sana ↔ 日曜日の秘密(ずっと前から好きでした。~告白実行委員会~ OST) / HoneyWorks meets CHiCO & sana
  ['ky', '44504', '446356'], // ky-44504 REAL×EYEZ (特撮"仮面ライダーゼロワン") / J×Takanori Nishikawa ↔ REAL × EYEZ(仮面ライダーゼロワン OP) / J × Takanori Nishikawa
  ['ky', '44520', '447173'], // ky-44520 No.7 / 地縛少年バンド ↔ No.7(地縛少年花子くん OP) / 地縛少年バンド(生田鷹司×オーイシマサヨシ×ZiNG)
  ['ky', '44886', '612018'], // ky-44886 カナデトモスソラ / 25時、ナイトコードで。×巡音ルカ ↔ カナデトモスソラ('プロジェクトセカイ カラフルステージ！ feat. 初音ミク' OST) / 25時,ナイトコードで。
  ['ky', '57747', '627223'], // ky-57747 メズマライザー / 사츠키 ↔ メズマライザー / サツキ
  ['ky', '75855', '618643'], // ky-75855 VIVA LA LIBERATION / 橋詰知久 ↔ VIVA LA LIBERATION / 天堂天彦,カリスマ
  ['ky', '75901', '618645'], // ky-75901 雪解 / 日向朔公 ↔ 雪解('カリスマ' OST) / 湊大瀬
  ['ky', '75902', '618647'], // ky-75902 LONE WOLF / 細田健太 ↔ LONE WOLF / 猿川慧
  ['tj', '6115', '320'], // tj-6115 北空港 / 桂銀淑,浜圭介 ↔ 北空港 / 浜圭介/桂銀淑
  ['tj', '6177', '16100'], // tj-6177 生命のブルース / 黑澤明とロス・プリモス ↔ 生命のブルース / 黒沢明とロス・プリモス
  ['tj', '6184', '84'], // tj-6184 愛されてセレナーデ / ヤンㆍスギョン ↔ 愛されてセレナーデ / ヤン・スギョン
  ['tj', '6245', '2534'], // tj-6245 あなたの灯 / 五木ひろし ↔ あなたの灯(ともしび) / 五木ひろし
  ['tj', '6260', '16106'], // tj-6260 信濃川慕情 / 黑澤明とロス・プリモス ↔ 信濃川慕情 / 黒沢明とロス・プリモス
  ['tj', '6282', '23848'], // tj-6282 城ヶ崎ブルース / 黑澤明とロス・プリモス ↔ 城ヶ崎ブルース / 黒沢明とロス・プリモス
  ['tj', '6305', '23844'], // tj-6305 薩摩の女 / 北島三郎 ↔ 薩摩の女(ひと) / 北島三郎
  ['tj', '6339', '27166'], // tj-6339 愛のふれあい / 澤ひろしとTOKYO 99 ↔ 愛のふれあい / 沢ひろしとTokyo99
  ['tj', '6352', '2165'], // tj-6352 アマン / 菅原洋一＆シルビア ↔ アマン / 菅原洋一/シルヴィア
  ['tj', '6455', '27183'], // tj-6455 誰よりも君を愛す / マヒナスターズ,松尾和子 ↔ 誰よりも君を愛す / 松尾和子/和田弘とマヒナスターズ
  ['tj', '6459', '19748'], // tj-6459 だんご3兄弟(おかあさんといっしょよりだんご３兄弟 主題歌) / だんご合唱団 外 ↔ だんご3兄弟 / 速水けんたろう/茂森あゆみ/ひまわりキッズ&だんご合唱団
  ['tj', '6520', '994'], // tj-6520 麦畑 / オヨネーズむぎふみシスターズ ↔ 麦畑 / オヨネーズ
  ['tj', '6538', '13145'], // tj-6538 夢酔枕 / 堀内孝雄 ↔ 夢酔枕(ゆめよいまくら) / 堀内孝雄
  ['tj', '6541', '360'], // tj-6541 演歌みたいな別れでも / 梅澤富美男 ↔ 演歌みたいな別れでも / 梅沢富美男
  ['tj', '6555', '3542'], // tj-6555 別れ曲でも唄って / 前川清 ↔ 別れ曲でも唄って〈シングルヴァージョン〉 / 前川清
  ['tj', '6579', '17108'], // tj-6579 ROCKET DIVE(AWOL OP) / hide with Spread Beaver ↔ Rocket Dive / hide
  ['tj', '6584', '16099'], // tj-6584 雨の銀座 / 黑澤明とロス・プリモス ↔ 雨の銀座 / 黒沢明とロス・プリモス
  ['tj', '6741', '3786'], // tj-6741 おもかげの女 / 石原裕次郎 ↔ おもかげの女(ひと) / 石原裕次郎
  ['tj', '6794', '16143'], // tj-6794 ひだまりの詩 / La Couple ↔ ひだまりの詩 / Le Couple(ル・クプル)
  ['tj', '6833', '3478'], // tj-6833 愛冠岬 / 松原のぶえ ↔ 愛冠岬(アイカップミサキ) / 松原のぶえ
  ['tj', '6836', '1628'], // tj-6836 愛は別離 / 川中美幸 ↔ 愛は別離(わかれ) / 川中美幸
  ['tj', '25148', '2492'], // tj-25148 はじまりはいつも雨 / Chage & Aska ↔ はじまりはいつも雨 / ASKA
  ['tj', '25247', '12446'], // tj-25247 シングルベッド(D.N.A2 ED) / シャ乱Ｑ ↔ シングルベッド / シャ乱Q
  ['tj', '25311', '3189'], // tj-25311 Always～伝えたい～ / Toshi ↔ Always ～伝えたい～ / Toshl
  ['tj', '25499', '52814'], // tj-25499 WINTER WISH(ラブひな WINTER SPECIAL) / 米倉千尋 ↔ WINTER WISH / 米倉千尋
  ['tj', '25567', '34901'], // tj-25567 熱風！疾風！サイバスター(スーパーロボット大戦α外伝 OST) / 水木一郎,MIO,影山ヒロノブ ↔ 熱風!疾風!サイバスター / 水木一郎/影山ヒロノブ
  ['tj', '25607', '147163'], // tj-25607 Like Hell / Loudness ↔ LIKE HELL / ラウドネス
  ['tj', '25640', '11509'], // tj-25640 ひとりぼっちのハブラシ(ムコ殿 OST) / 桜庭裕一郎 TOKIO ↔ ひとりぼっちのハブラシ / 桜庭裕一郎(長瀬智也)
  ['tj', '25718', '35378'], // tj-25718 Count down(GEAR戦士電童 ED) / Little Voice ↔ COUNT DOWN(カウントダウン) / Little Voice
  ['tj', '25937', '70643'], // tj-25937 合神！ゴッドグラヴィオン(超重神グラヴィオンOST) / JAM Project(Feat.遠藤正明) ↔ 合神!ゴッドグラヴィオン / JAM Project featuring 遠藤正明
  ['tj', '26055', '26087'], // tj-26055 出張物語 / 吉 幾三・川中美幸 ↔ 出張物語 / 川中美幸/吉幾三
  ['tj', '26077', '10469'], // tj-26077 城崎恋歌 / 細川たかし ↔ 城崎恋歌(きのさきこいうた) / 細川たかし
  ['tj', '26139', '17744'], // tj-26139 北のともしび / 五木ひろし,天童よしみ ↔ 北のともしび / 天童よしみ/五木ひろし
  ['tj', '26150', '26307'], // tj-26150 どんなにうまい嘘だって / 高島礼子,村田雅浩 ↔ どんなにうまい嘘だって / 高島礼子/村田雄浩
  ['tj', '26155', '28150'], // tj-26155 あづま男と浪花のおんな / 北島三郎,中村美津子 ↔ あづま男と浪花のおんな / 北島三郎/中村美律子
  ['tj', '26162', '2542'], // tj-26162 愛して愛して 愛しちゃったのよ / 和田弘とマヒナスターズ,田代美代子 ↔ 愛して愛して愛しちゃったのよ / 田代美代子/和田弘とマヒナスターズ
  ['tj', '26181', '78113'], // tj-26181 月の呪縛(カース)(LOVELESS OP) / 翁鈴佳 ↔ 月の呪縛 / 翁鈴佳
  ['tj', '26452', '125614'], // tj-26452 恋のミクル伝説(涼宮ハルヒの憂鬱 OST) / 伴都美子 ↔ 恋のミクル伝説 / 朝比奈みくる(後藤邑子)
  ['tj', '26460', '127069'], // tj-26460 Face of Fact(BALDR FORCE EXE RESOLUTION OP) / KOTOKO ↔ Face of Fact〈RESOLUTION ver.〉 / KOTOKO
  ['tj', '26465', '51027'], // tj-26465 Peace of mind(蒼穹のファフナー RIGHT OF LEFT) / angela ↔ Peace of mind / angela
  ['tj', '26474', '79287'], // tj-26474 未来への咆哮(マブラヴ オルタネイティヴ トータル・イクリプス OP) / JAM Project(Feat.male 影山ヒロノブ 外) ↔ 未来への咆哮 / JAM Project feat.影山ヒロノブ・遠藤正明・きただにひろし・福山芳樹
  ['tj', '26475', '164117'], // tj-26475 微熱S.O.S!!(THE IDOLM@STER XENOGLOSSIA OP) / 橋本みゆき ↔ 微熱S.O.S!! / 橋本みゆき
  ['tj', '26550', '78100'], // tj-26550 ピカピカの太陽(学園アリス OP) / 植田佳奈 ↔ ピカピカの太陽 / 佐倉蜜柑(植田佳奈)
  ['tj', '26573', '78101'], // tj-26573 幸せの虹(学園アリス ED) / 植田佳奈&釘宮理恵 ↔ 幸せの虹 / 佐倉蜜柑(植田佳奈)/今井蛍(釘宮理恵)
  ['tj', '26576', '162969'], // tj-26576 GUILTY BEAUTY LOVE(桜蘭高校ホスト部 Character Song) / 宮野真守 ↔ GUILTY BEAUTY LOVE / 須王環(宮野真守)
  ['tj', '26636', '31937'], // tj-26636 Bomb A Head! Returns!(天上天下 OP) / M.C.A.T(Feat.DA PUMP) ↔ Bomb A Head! Returns! / m.c.A・T
  ['tj', '26800', '172654'], // tj-26800 Double-Action CLIMAX form / 野上良太郎＆モモタロス ↔ Double-Action CLIMAX form / モモタロス(関俊彦)・ウラタロス(遊佐浩二)・キンタロス(てらそままさき)・リュウタロス(鈴村健一)・デネブ(大塚芳忠)
  ['tj', '26834', '170715'], // tj-26834 COOL EDITION(涼宮ハルヒの憂鬱 Character Song) / 朝倉涼子 ↔ COOL EDITION / 朝倉涼子(桑谷夏子)
  ['tj', '26868', '31641'], // tj-26868 The Gate of the Hell(マジンカイザー 死闘！暗黒大将軍 OP) / JAM Project ↔ The Gate of the Hell / JAM Project featuring 福山芳樹
  ['tj', '26917', '137442'], // tj-26917 下剋上 / 鏡音リン&鏡音レン ↔ 下剋上(完) / 一行P feat.鏡音リン、鏡音レン
  ['tj', '26923', '135038'], // tj-26923 ダブルラリアット / 巡音ルカ ↔ ダブルラリアット / アゴアニキ
  ['tj', '26954', '138973'], // tj-26954 Just Be Friends / 巡音ルカ ↔ Just Be Friends / Dixie Flatline feat.巡音ルカ
  ['tj', '26965', '139530'], // tj-26965 ダンシング☆サムライ / 神威がくぽ ↔ ダンシング☆サムライ / かにみそP feat.神威がくぽ
  ['tj', '26999', '941652'], // tj-26999 So lonely / Loudness ↔ SO LONELY / ラウドネス
  ['tj', '27012', '91750'], // tj-27012 You were... / 浜崎あゆみ ↔ You were...〈Original mix〉 / 浜崎あゆみ
  ['tj', '27038', '137779'], // tj-27038 右肩の蝶 / 鏡音リン ↔ 右肩の蝶〈リンver.〉 / のりP feat.鏡音リン
  ['tj', '27039', '139620'], // tj-27039 パラジクロロベンゼン / 鏡音レン ↔ パラジクロロベンゼン / オワタP feat.鏡音レン
  ['tj', '27046', '138996'], // tj-27046 ペテン師が笑う頃に / 初音ミク ↔ ペテン師が笑う頃に / 梨本うい feat.初音ミク
  ['tj', '27066', '138115'], // tj-27066 IMITATION BLACK / 神威がくぽ, KAITO, 鏡音レン ↔ IMITATION BLACK / natsuP(SCL Project) feat.VanaN'Ice
  ['tj', '27098', '91999'], // tj-27098 Always(サヨナライツカ OST) / 中島美嘉 ↔ ALWAYS / 中島美嘉
  ['tj', '27147', '5293'], // tj-27147 ユカイツーカイ怪物くん / 怪物くん ↔ ユカイツーカイ怪物くん / 野沢雅子
  ['tj', '27243', '29271'], // tj-27243 In My Head(SUPERNATURAL : THE ANIMATION) / CNBLUE ↔ In My Head / CNBLUE
  ['tj', '27325', '27756'], // tj-27325 ブルーバード (Blue Bird)(NARUTO-ナルト-疾風伝 OP) / いきものがかり ↔ ブルーバード / いきものがかり
  ['tj', '27380', '32341'], // tj-27380 Powder Snow ~永遠に終わらない冬~ / 三代目 J Soul Brothers ↔ Powder Snow ～永遠に終わらない冬～ / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27416', '145546'], // tj-27416 パンダヒーロー / GUMI ↔ パンダヒーロー / ハチ
  ['tj', '27522', '119185'], // tj-27522 満天の瞳 / 氷川きよし ↔ 満天の瞳(ほし) / 氷川きよし
  ['tj', '27657', '726245'], // tj-27657 START:DASH!!(ラブライブ! OST) / μ's ↔ START:DASH!! / 高坂穂乃果(CV.新田恵海)南ことり(CV.内田彩)園田海未(CV.三森すずこ)
  ['tj', '27727', '119402'], // tj-27727 一声一代 / 天童よしみ ↔ 一声一代(いっせいいちだい) / 天童よしみ
  ['tj', '27784', '129647'], // blog-163-96 白昼の夢 / SEKAI NO OWARI ↔ 白昼の夢 / 世界の終わり
  ['tj', '27823', '671782'], // tj-27823 海色(艦隊これくしょん-艦これ- OP) / AKINO With bless4 ↔ 海色(みいろ) / AKINO from bless4
  ['tj', '27867', '178158'], // tjpdf-27867 経験値速上々↑↑ / 佐藤利奈,井上麻里奈,茅原実里 ↔ 経験値速上々↑↑ / 南春香(佐藤利奈)/南夏奈(井上麻里奈)/南千秋(茅原実里)
  ['tj', '27876', '78683'], // tjpdf-27876 Go Tight! / AKINO ↔ Go Tight! / AKINO from bless4
  ['tj', '27878', '174317'], // tjpdf-27878 ？でわっしょい / 阿澄佳奈,水橋かおり,後藤邑子,新谷良子 ↔ ?でわっしょい / ゆの(阿澄佳奈)、宮子(水橋かおり)、ヒロ(後藤邑子)、沙英(新谷良子)
  ['tj', '28015', '168735'], // tjpdf-28015 BAMBOO BEAT / 広橋涼,他 ↔ BAMBOO BEAT / 川添珠姫(広橋涼)/千葉紀梨乃(豊口めぐみ)/桑原鞘子(小島幸子)/宮崎都(桑島法子)/東聡莉(佐藤利奈)
  ['tj', '28138', '106236'], // tjpdf-28138 Super∞Stream / 日笠陽子,ゆかな 他 ↔ SUPER∞STREAM / 篠ノ之箒(cv.日笠陽子)、セシリア・オルコット(cv.ゆかな)、凰鈴音(cv.下田麻美)、シャルル・デュノア(cv.花澤香菜)、ラウラ・ボーデヴィッヒ(cv.井上麻里奈)
  ['tj', '28188', '672515'], // tjpdf-28188 お願い!シンデレラ / 高垣楓,他 ↔ お願い!シンデレラ / 高垣楓、城ヶ崎美嘉、小日向美穂、十時愛梨、川島瑞樹、日野茜、輿水幸子、佐久間まゆ、白坂小梅
  ['tj', '28261', '728580'], // tjpdf-28261 ポワゾンKISS / QUARTET NIGHT ↔ ポワゾンKISS / QUARTET NIGHT(寿嶺二・黒崎蘭丸・美風藍・カミュ/CV:森久保祥太郎・鈴木達央・蒼井翔太・前野智昭)
  ['tj', '28522', '736143'], // tjpdf-28522 ビュンビュン!トッキュウジャー / Project.R ↔ ビュンビュン! トッキュウジャー / Project.R(YOFFY、谷本貴義、鎌田章吾)
  ['tj', '28526', '22619'], // tjpdf-28526 Alive A Life / 松本梨香 ↔ Alive A life(アライヴアライフ) / 松本梨香
  ['tj', '28548', '168460'], // tjpdf-28548 Euphoric Field / ELISA ↔ euphoric field〈English〉 / ELISA
  ['tj', '28549', '501261'], // tjpdf-28549 真夜中の饗宴(MIDNIGHT PLEASURE) / 緑川光,鳥海浩輔,近藤隆 ↔ 真夜中の饗宴 / 逆巻アヤト(CV.緑川光)・逆巻シュウ(CV.鳥海浩輔)・逆巻スバル(CV.近藤隆)
  ['tj', '28640', '177020'], // blog-1229-209 Blue Moon / 水樹奈々 ↔ Blue Moon / ほしな歌唄(水樹奈々)
  ['tj', '28644', '167646'], // tjpdf-28644 絶世美人 / 大槻ケンヂと絶望少女達 ↔ 絶世美人 / 絶望少女達(風浦可符香、木津千里、木村カエレ、日塔奈美)
  ['tj', '28677', '692747'], // tj-28677 ようこそジャパリパークへ(けものフレンズ OP) / どうぶつビスケッツxPPP ↔ ようこそジャパリパークへ / どうぶつビスケッツ×PPP
  ['tj', '28695', '129482'], // blog-505-0 白い雪のプリンセスは / のぼる↑Ｐ(Feat.初音ミク) ↔ 白い雪のプリンセスは / のぼる↑ feat.初音ミク
  ['tj', '28697', '692986'], // tjpdf-28697 ロメオ / LIPxLIP ↔ ロメオ / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長)
  ['tj', '28713', '696746'], // tj-28713 Precious You☆(ロクでなし魔術講師と禁忌教典 ED) / 藤田茜,宮本侑芽,小澤亜李 ↔ Precious You☆ / システィーナ=フィーベル(CV:藤田茜) ルミア=ティンジェル(CV:宮本侑芽) リィエル=レイフォード(CV:小澤亜李)
  ['tj', '28741', '696487'], // tj-28741 JUMPin' JUMP UP!!!!(NEW GAME!! ED) / Fourfolium ↔ JUMPin' JUMP UP!!!! / fourfolium 涼風青葉(CV:高田憂希)、滝本ひふみ(CV:山口愛)、篠田はじめ(CV:戸田めぐみ)、飯島ゆん(CV:竹尾歩美)
  ['tj', '28792', '423462'], // tj-28792 ノンファンタジー(いつだって僕らの恋は10センチだった。OP) / LIPxLIP ↔ ノンファンタジー / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長)
  ['tj', '28893', '429142'], // tj-28893 WAR WAR WAR(ヒプノシスマイク) / Buster Bros!!!,MAD TRIGGER CREW ↔ WAR WAR WAR / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平)・MAD TRIGGER CREW(CV.浅沼晋太郎・駒田航・神尾晋一郎)
  ['tj', '28894', '429143'], // tj-28894 IKEBUKURO WEST GAME PARK(ヒプノシスマイク) / Buster Bros!!! ↔ IKEBUKURO WEST GAME PARK / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平)
  ['tj', '28895', '446980'], // blog-338-10 アイノカタチ(ドラマ'義母と娘のブルース' OST) / MISIA(Feat.HIDE(GReeeeN)) ↔ アイノカタチ / MISIA
  ['tj', '28899', '699477'], // tj-28899 ステップアップLove(血界戦線 ED) / DAOKO X 岡村靖幸 ↔ ステップアップLOVE / DAOKO × 岡村靖幸
  ['tj', '28901', '425317'], // tj-28901 シャンパンゴールド(ヒプノシスマイク) / 木島隆一 ↔ シャンパンゴールド / 伊弉冉一二三(CV.木島隆一)
  ['tj', '28905', '431013'], // tj-28905 BATTLE BATTLE BATTLE(ヒプノシスマイク) / Fling Posse,摩天狼 ↔ BATTLE BATTLE BATTLE / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏)・麻天狼 (CV. 速水奨・木島隆一・伊東健人)
  ['tj', '28917', '431015'], // tj-28917 Shibuya Marble Texture-PCCS-(ヒプノシスマイク) / Fling Posse ↔ Shibuya Marble Texture-PCCS- / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏)
  ['tj', '28924', '429144'], // tj-28924 Yokohama Walker(ヒプノシスマイク) / MAD TRIGGER CREW ↔ Yokohama Walker / MAD TRIGGER CREW(CV.浅沼晋太郎・駒田航・神尾晋一郎)
  ['tj', '28928', '433011'], // tjpdf-28928 夢ファンファーレ / LIPxLIP ↔ 夢ファンファーレ / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長)
  ['tj', '28936', '434190'], // tj-28936 DEATH RESPECT(ヒプノシスマイク) / MAD TRIGGER CREW,麻天狼 ↔ DEATH RESPECT / MAD TRIGGER CREW (CV.浅沼晋太郎・駒田航・神尾晋一郎)・麻天狼 (CV.速水奨・木島隆一・伊東健人)
  ['tj', '28945', '698899'], // tj-28945 Deep in Abyss(メイドインアビス OP) / 富田美憂,伊瀨茉莉也 ↔ Deep in Abyss / リコ(CV:富田美憂)、レグ(CV:伊瀬茉莉也)
  ['tj', '28979', '425419'], // tj-28979 3$EVEN(ヒプノシスマイク) / 野津山幸宏 ↔ 3$EVEN / 有栖川帝統(CV.野津山幸宏)
  ['tj', '28982', '425316'], // tj-28982 チグリジア(ヒプノシスマイク) / 伊東健人 ↔ チグリジア / 観音坂独歩(CV.伊東健人)
  ['tj', '29000', '685223'], // tjpdf-29000 pride-Louis Ver.- / 蒼井翔太 ↔ pride -Louis ver.- / 如月ルヰ (CV.蒼井翔太)
  ['tj', '52805', '129581'], // blog-163-92 死の魔法 / SEKAI NO OWARI ↔ 死の魔法 / 世界の終わり
  ['tj', '66064', '627341'], // tj-66064 夢幻(アニメ ''鬼滅の刃'柱稽古編' OST) / MY FIRST STORY & HYDE ↔ 夢幻 / MY FIRST STORY
  ['tj', '66207', '627793'], // tj-66207 永久 -トコシエ-(アニメ ''鬼滅の刃'柱稽古編' OST) / MY FIRST STORY & HYDE ↔ 永久 -トコシエ- / HYDE×MY FIRST STORY
  ['tj', '68037', '438772'], // tj-68037 Hoodstar(ヒプノシスマイク) / Division All Stars ↔ Hoodstar / Division All Stars
  ['tj', '68059', '439222'], // tj-68059 366LOVEダイアリー(KING OF PRISM-Shiny Seven Stars- ED) / 寺島惇太,斉藤壮馬,八代拓,畠中祐,永塚拓馬,五十嵐雅,内田雄馬 ↔ 366LOVEダイアリー / 一条シン、太刀花ユキノジョウ、香賀美タイガ、十王院カケル、鷹梁ミナト、西園寺レオ、涼野ユウ (CV.寺島惇太、斉藤壮馬、畠中祐、八代拓、五十嵐雅、永塚拓馬、内田雄馬)
  ['tj', '68139', '444809'], // tj-68139 みせて、あなたを(アナと雪の女王2 OST) / 松たか子,吉田羊 ↔ みせて、あなたを / 松たか子(エルサ)、吉田羊(イドゥナ王妃)
  ['tj', '68140', '444805'], // tj-68140 ずっとかわらないもの(アナと雪の女王2 OST) / 神田沙也加,松たか子,武内駿輔,原慎一郎,『アナと雪の女王2』キャスト ↔ ずっとかわらないもの / 神田沙也加(アナ)、松たか子(エルサ)、武内駿輔(オラフ)、原慎一郎(クリストフ)
  ['tj', '68150', '444008'], // tj-68150 あゝオオサカdreamin'night(ヒプノシスマイク) / どついたれ本舗 ↔ あゝオオサカdreamin'night / どついたれ本舗(CV:岩崎諒太・河西健吾・黒田崇矢)
  ['tj', '68172', '430573'], // tj-68172 二重の虹(ダブル レインボウ)(BanG Dream! OST) / Poppin'Party ↔ 二重の虹 / Poppin'Party
  ['tj', '68175', '487358'], // tj-68175 竈門炭治郎のうた(鬼滅の刃 ED) / 椎名豪(Feat.中川奈美) ↔ 竈門炭治郎のうた / 椎名豪 featuring 中川奈美
  ['tj', '68185', '684588'], // tj-68185 ベルセルク / まふまふ ↔ ベルセルク / After the Rain [そらる×まふまふ]
  ['tj', '68197', '444994'], // tj-68197 月光陰 -Moonlight Shadow- / ヒプノシスマイク-D.R.B-(四十物 十四) ↔ 月光陰 -Moonlight Shadow- / 四十物十四(CV:榊原優希)
  ['tj', '68218', '446195'], // tj-68218 DRIVE US CRAZY(BanG Dream!) / RAISE A SUILEN ↔ DRIVE US CRAZY / RAISE A SUILEN
  ['tj', '68219', '424809'], // tj-68219 動く、動く(少女終末旅行 OP) / 水瀬いのり,久保ユリカ ↔ 動く、動く / チト(CV:水瀬いのり)、ユーリ(CV:久保ユリカ)
  ['tj', '68231', '448464'], // tj-68231 パーティーを止めないで(ヒプノシスマイク) / 木島隆一 ↔ パーティーを止めないで / 伊弉冉一二三(CV.木島隆一)
  ['tj', '68256', '448614'], // tj-68256 BLACK DEJAVU(うたの☆プリンスさまっ♪Another World～WHITE&BLACK～OST) / BLACK DEJAVU ↔ BLACK DEJAVU / BLACK DEJAVU[一十木音也(CV.寺島拓篤)、一ノ瀬トキヤ(CV.宮野真守)、神宮寺レン(CV.諏訪部順一)、寿嶺二(CV.森久保祥太郎)、黒崎蘭丸(CV.鈴木達央)]
  ['tj', '68267', '485516'], // tj-68267 イケナイGO AHEAD(アイドルマスターシンデレラガールズスターライトステージ OST) / 照井春佳,佐藤亜美菜,花井美春 ↔ イケナイGO AHEAD / 櫻井桃華(CV:照井春佳)、橘ありす(CV:佐藤亜美菜)、村上巴(CV:花井美春)
  ['tj', '68271', '726378'], // tj-68271 Hello Alone(やはり俺の青春ラブコメはまちがっている。 ED) / 早見沙織,東山奈央 ↔ Hello Alone / 雪ノ下雪乃(CV.早見沙織)&由比ヶ浜結衣(CV.東山奈央)
  ['tj', '68280', '485882'], // tj-68280 Survival of the Illest(ヒプノシスマイク) / Division All Stars ↔ Survival of the Illest / Division All Stars
  ['tj', '68304', '439268'], // tj-68304 凸凹スピードスター(M@STER VERSION)(アイドルマスターシンデレラガールズスターライトステージ OST) / 三宅麻理恵,花守ゆみり ↔ 凸凹スピードスター(M@STER VERSION) / 安部菜々(CV:三宅麻理恵)、佐藤心(CV:花守ゆみり)
  ['tj', '68316', '446332'], // tj-68316 カイト(NHK2020ソング) / 嵐 ↔ カイト / 嵐
  ['tj', '68327', '448411'], // tj-68327 Dye the sky.(THE IDOLM@STER SHINY COLORS OST) / シャイニーカラーズ ↔ Dye the sky. / シャイニーカラーズ
  ['tj', '68377', '487824'], // tj-68377 絆(ヒプノシスマイク -D.R.B- Rhyme Anima) / Division All Stars ↔ 絆 / Division All Stars
  ['tj', '68388', '489368'], // tj-68388 LOVE&KISS / LIPxLIP ↔ LOVE&KISS / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長)
  ['tj', '68412', '489561'], // tj-68412 Black Journey(ヒプノシスマイク) / Fling Posse ↔ Black Journey / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏)
  ['tj', '68421', '488993'], // tj-68421 ユメヲカケル！(ウマ娘プリティーダービー OST) / 和氣あず未,高野麻里佳,Machico,大橋彩香,木村千咲,上田瞳,大西沙織 ↔ ユメヲカケル! / スピカ[スペシャルウィーク(CV.和氣あず未)、サイレンススズカ(CV.高野麻里佳)、トウカイテイオー(CV.Machico)、ウオッカ(CV.大橋彩香)、ダイワスカーレット(CV.木村千咲)、ゴールドシップ(CV.上田瞳)、メジロマックイーン(CV.大西沙織)]
  ['tj', '68425', '489534'], // tj-68425 Reason to FIGHT(ヒプノシスマイク) / Fling Posse,MAD TRIGGER CREW ↔ Reason to FIGHT / Fling Posse(CV.白井悠介・斉藤壮馬・野津山幸宏)・MAD TRIGGER CREW(CV.浅沼晋太郎・駒田航・神尾晋一郎)
  ['tj', '68449', '486752'], // tj-68449 恋のうた(トニカクカワイイ OST) / Yunomi(Feat.由崎司) ↔ 恋のうた (feat. 由崎司) / 由崎司 (CV:鬼頭明里)
  ['tj', '68497', '628991'], // tj-68497 シカ色デイズ(TVアニメ 'しかのこのこのここしたんたん' OST) / 鹿乃子のこ,虎視虎子,虎視餡子,馬車芽めめ ↔ シカ色デイズ / シカ部【鹿乃子のこ (CV.潘めぐみ) 、虎視虎子 (CV.藤田咲) 、虎視餡子 (CV.田辺留依) 、馬車芽めめ (CV.和泉風花) 】
  ['tj', '68502', '490520'], // tj-68502 カモナ・テンペスト！(転生したらスライムだった件転スラ日記 ED) / 岡咲美保,豊口めぐみ,前野智昭,千本木彩花,M・A・O,小林親弘,泊 明日菜 ↔ カモナ・テンペスト! / リムル (CV.岡咲美保)、大賢者 (CV.豊口めぐみ)、ヴェルドラ (CV.前野智昭)、シオン (CV.M・A・O)、シュナ (CV.千本木彩花)、ゴブタ (CV.泊明日菜)、ランガ (CV.小林親弘)
  ['tj', '68513', '498108'], // tj-68513 Hang out!(ヒプノシスマイク) / Division All Stars ↔ Hang out! / Division All Stars
  ['tj', '68529', '489866'], // tj-68529 Viva! Spark! トロピカル～ジュ！プリキュア(トロピカル～ジュ！プリキュア OP) / Machico コーラス：トロピカる部 ↔ Viva! Spark! トロピカル～ジュ!プリキュア / Machico
  ['tj', '68549', '486325'], // tj-68549 Femme Fatale(ヒプノシスマイク) / 中王区言の葉党 ↔ Femme Fatale / 中王区 言の葉党
  ['tj', '68593', '489421'], // tj-68593 開眼(ヒプノシスマイク) / Bad Ass Temple ↔ 開眼 / Bad Ass Temple(CV:葉山翔太・榊原優希・竹内栄治)
  ['tj', '68594', '489049'], // tj-68594 Re:start!!!(ヒプノシスマイク) / Buster Bros!!! ↔ Re:start!!! / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平)
  ['tj', '68597', '495752'], // tj-68597 君が見た夢の物語(ロード・エルメロイⅡ世の事件簿 -魔眼蒐集列車- Grace note) / ASCA ↔ 君が見た夢の物語 / ASCA
  ['tj', '68643', '498881'], // tj-68643 ジュリエッタ(ヒロインたるもの!~嫌われヒロインと内緒のお仕事~OP) / LIPxLIP ↔ ジュリエッタ / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長)
  ['tj', '68666', '197416'], // tj-68666 あんずのうた('THE IDOL M@STER CINDERELLA GIRLS' OST) / 五十嵐裕美 ↔ あんずのうた / 双葉杏(CV五十嵐裕美)
  ['tj', '68823', '612984'], // tj-68823 可愛くてごめん / HoneyWorks(Feat.かぴ) ↔ 可愛くてごめん (feat.かぴ) / HoneyWorks
  ['tj', '68844', '497916'], // tj-68844 STAGE OF SEKAI / 針原翼(はりーP)(Feat.初音ミク) ↔ STAGE OF SEKAI / はりーP feat.初音ミク
  ['tj', '68913', '487546'], // tj-68913 Back Off(プロジェクト 'Paradox Live' OST) / cozmez ↔ Back Off / cozmez
  ['tj', '68919', '487545'], // tj-68919 REBELLION -悪漢奴等 is still Burning-(プロジェクト 'Paradox Live' OST) / 悪漢奴等 ↔ REBELLION -悪漢奴等 is still Burning- / 悪漢奴等
  ['tj', '68935', '618669'], // tj-68935 命短し尽くせよ奴隷 / 本橋依央利/カリスマ ↔ 命短し尽くせよ奴隷 / 本橋依央利
  ['tj', '68936', '618670'], // tj-68936 秩序宣言 / 草薙理解/カリスマ ↔ 秩序宣言 / 草薙理解
  ['tj', '68948', '619503'], // tj-68948 Charisma Battle Anthem / 伊藤ふみや/カリスマ ↔ Charisma Battle Anthem / 伊藤ふみや feat. 六人のカリスマ
  ['tj', '68959', '618642'], // tj-68959 When The Charisma Go Marching In / 伊藤ふみや/カリスマ ↔ When The Charisma Go Marching In / 伊藤ふみや
  ['tj', '68962', '618646'], // tj-68962 LOVE MYSELF / テラ/カリスマ ↔ LOVE MYSELF / テラ
  ['tj', '68965', '433738'], // tj-68965 不可思議のカルテ(アニメ '青春ブタ野郎シリーズ' OST) / 瀬戸麻沙美,東山奈央,種﨑敦美,内田真礼,久保ユリカ,水瀬いのり ↔ 不可思議のカルテ / 桜島麻衣、古賀朋絵、双葉理央、豊浜のどか、梓川かえで、牧之原翔子(CV:瀬戸麻沙美、東山奈央、種崎敦美、内田真礼、久保ユリカ、水瀬いのり)
  ['tj', '68988', '617202'], // tj-68988 Pieces of The World(劇場版 'IDOLiSH7 LIVE 4bit Compilation Album ''BEYOND THE PERiOD''' OST) / IDOLiSH7,TRIGGER,Re:vale,ZOOL ↔ Pieces of The World / IDOLiSH7 & TRIGGER & Re:vale & ZOOL
  ['tj', '68992', '680334'], // tj-68992 MONSTER GENERATiON('劇場版 IDOLiSH7 LIVE 4bit Compilation Album ''BEYOND THE PERiOD''' OST) / IDOLiSH7 ↔ MONSTER GENERATiON / IDOLiSH7
  // --- 2026-07-20 owner adjudication. Three pairs released from
  // REVIEWED_TIER_F_FORBIDDEN_PAIRS (25022|11802 short-numeric "19"; 68183|683200
  // and 68290|731408 reviewed-but-not-strong credit) plus two B-wave "uncertain"
  // rows the owner confirmed as merges via the D-1 supplemental verdicts
  // (ky-40449 忘れていいの duet cut; tj-28672 Baby I Love U English Ver., a
  // tj-only target so it lands in Tier F). Lines emitted verbatim by
  // scripts/encode-b-wave-merge-pairs.mjs. Effective at the next JOYSOUND-crawl
  // corpus (v24+ re-merge). See docs/ROADMAP.md. ---
  ['ky', '40449', '1546'], // ky-40449 忘れていいの / 谷村新司、小川知子 ↔ 忘れていいの -愛の幕切れ- / 谷村新司/小川知子
  ['tj', '25022', '11802'], // tj-25022 たいせつなひと / 19 ↔ たいせつなひと / 19(ジューク)
  ['tj', '28672', '28921'], // tj-28672 Baby I Love U / Che'Nelle ↔ BABY I LOVE U (English Ver.) / Che'Nelle
  ['tj', '68183', '683200'], // tj-68183 Radio Happy(アイドルマスターシンデレラガールズスターライトステージ OST) / 山下七海 ↔ Radio Happy / 大槻唯(CV:山下七海)
  ['tj', '68290', '731408'], // tj-68290 S(mile)ING!(アイドルマスターシンデレラガールズスターライトステージ OST) / 大橋彩香 ↔ S(mile)ING! / 島村卯月(CV大橋彩香)
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT = 482;
const REVIEWED_TIER_F_FORBIDDEN_PAIRS = [
  // 2026-07-20 owner adjudication RELEASED the "artist 19" short-numeric pairs
  // (25022|11802, 6927|19868, 6935|21182) and the reviewed-but-not-strong
  // tieup/credit pairs (26750|168779, 68183|683200, 68258|445312, 68290|731408)
  // — the B-wave web confirmation satisfied each prior hold. They now live in
  // the reviewed-strong allowlists (see the 2026-07-20 owner-adjudication
  // sections and docs/ROADMAP.md). Still held: the MISIA feat. HIDE(GReeeeN)
  // artist_ko-donor false positive.
  ['tj', '28895', '441874'], // MISIA feat. HIDE(GReeeeN) matched to GReeeeN-only artist_ko donor
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

// NOTE: the former `REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS` allowlist
// (which let a reviewed Tier F pair attach to a JOYSOUND row that already
// carried one specific extra tj/ky number — the `No title`/Reol and `再会`/LiSA
// triples) was removed with the 2026-07-17 reviewed-tier cluster-attach
// relaxation. The reviewed tiers now attach the pair regardless of the
// JOYSOUND side's cluster shape, gated only by the vendor-number conflict guard
// (which subsumes the old per-pair allowlist: those two triples merge because
// the guard finds no conflicting cell). See merge.ts
// `collectReviewedClusterAttachGroups`.

// Internal (only the forbidden-pair invariant below uses it).
function reviewedTierFPairKey(vendor: NonJoysoundVendor, number: string, joysound: string): string {
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

/**
 * Reviewed 3-way attach pairs (option B2, 2026-07-20 owner adjudication).
 *
 * A joysound number is normally owned by exactly ONE reviewed Tier E/F pair
 * (the unique-joysound invariant). For a small human-confirmed class the same
 * song exists under BOTH a tj and a ky number plus a joysound — a "3-way". The
 * owning pair supplies one single-vendor bridge; this table supplies the SECOND
 * single-vendor bridge (the OTHER non-joysound vendor) so all three records
 * collapse into one cluster. Each entry is `[vendor, number, joysound]` where
 * `joysound` is already owned by a Tier E/F pair of a DIFFERENT vendor.
 *
 * Semantics: the existing Tier E/F entries are untouched (diff 0). A dedicated
 * reviewed pipeline stage (merge.ts, in the Tier F position of TIER_PIPELINE)
 * runs the SAME `collectReviewedClusterAttachGroups` collector over these pairs
 * immediately AFTER Tier F. Because the E/F union is already applied, the
 * joysound cluster already carries the owning vendor's row, so the vendor-number
 * conflict guard sees the full 3-way union — a vendor-cell collision skips only
 * this attach and leaves the owning pair's merge intact (graceful partial
 * failure, unlike an atomic triple).
 *
 * The dup-J invariant is preserved in spirit: "one bridge per VENDOR per J".
 * The import-time assertions below add the FIRST cross-table invariant (every
 * attach J must exist in Tier E or F), STRENGTHENING the reviewed-tier
 * guarantees rather than weakening them.
 *
 * Lines emitted verbatim by scripts/encode-b-wave-merge-pairs.mjs from the
 * committed verdicts (83 derived ky rows whose joysound a tj pair owns, plus
 * the ky-41123 and tj-26145 supplemental adjudications — the latter is the
 * vendor-symmetric case: a tj bridge onto a ky-owned joysound). Effective at the
 * next JOYSOUND-crawl corpus (v24+ re-merge). See docs/ROADMAP.md and
 * docs/specs/2026-07-20-reviewed-3way-attach-design.md.
 */
const REVIEWED_TIER_F_3WAY_ATTACH_PAIRS = [
  ['ky', '40110', '2542'], // ky-40110 愛して愛して愛しちゃったのよ / 田代美代子 ↔ 愛して愛して愛しちゃったのよ / 田代美代子/和田弘とマヒナスターズ [owner tierF tj:26162]
  ['ky', '40119', '65161'], // ky-40119 スクランブル / 堀江由衣 with UNSCANDAL ↔ スクランブル(スクールランブル OP) / 堀江由衣 [owner tierE tj-25918]
  ['ky', '40120', '2165'], // ky-40120 アマン(Amant) / 菅原洋一&シルビア ↔ アマン / 菅原洋一/シルヴィア [owner tierF tj:6352]
  ['ky', '40126', '2120'], // ky-40126 熱海の夜 / 箱崎晋一郞 ↔ 熱海の夜 / 箱崎晋一郎 [owner tierE tj-6679]
  ['ky', '40141', '10140'], // ky-40141 ロボキッス / W(ダブルユー) ↔ ロボキッス / ダブルユー [owner tierF tj:25875]
  ['ky', '40150', '353'], // ky-40150 居酒屋 / 木の実ナナ、五木ひろし ↔ 居酒屋 / 五木ひろしと木の実ナナ [owner tierE tj-6191]
  ['ky', '40350', '27004'], // ky-40350 東京の灯よいつまでも / 新川二郞 ↔ 東京の灯よいつまでも / 新川二郎 [owner tierE tj-6464]
  ['ky', '40367', '21147'], // ky-40367 Catch You Catch Me / グミ ↔ Catch You Catch Me(カードキャプターさくら OP) / 日向めぐみ [owner tierE tj-25543]
  ['ky', '40543', '14786'], // ky-40543 檄! 帝国華撃団 / 横山智佐&帝国歌劇団 ↔ 檄! 帝国華撃団(サクラ大戦 OP) / 橫山智佐 外 [owner tierE tj-25232]
  ['ky', '40568', '28526'], // ky-40568 shine more / 安室奈美恵 ↔ shine more / 安室奈美惠 [owner tierF tj:25515]
  ['ky', '40576', '32521'], // ky-40576 あぁ いいな! / W(ダブルユー) ↔ あぁいいな!(ドラえもん ED) / ダブルユー [owner tierE tj-25963]
  ['ky', '40579', '37378'], // ky-40579 FIRE WARS / JAM Project featuring 影山ヒロノブ ↔ Fire wars(マジンカイザーOP) / JAM Project [owner tierE tj-25663]
  ['ky', '40747', '2337'], // ky-40747 カスマプゲ（胸がせつない） / 李成愛 ↔ カスマプゲ / 李 成愛 [owner tierE tj-6151]
  ['ky', '40794', '27068'], // ky-40794 さよならはダンスの後に / 倍賞千恵子 ↔ さよならはダンスの後に / 倍賞千惠子 [owner tierF tj:6633]
  ['ky', '40822', '27150'], // ky-40822 蘇州夜曲 / 霧島昇、渡辺はま子 ↔ 蘇州夜曲 / 渡辺はま子 [owner tierF tj:6449]
  ['ky', '40918', '1006'], // ky-40918 め組のひと / ラッツ&スター ↔ め組のひと('UQ mobile' CM) / RATS&STAR [owner tierE tj-52758]
  ['ky', '40952', '2331'], // ky-40952 離別 / 李成愛 ↔ 離別(イビョル) / 李 成愛 [owner tierF tj:6324]
  ['ky', '41015', '24985'], // ky-41015 NEVER END / 安室奈美恵 ↔ NEVER END / 安室奈美惠 [owner tierF tj:6942]
  ['ky', '41050', '19877'], // ky-41050 RESPECT the POWER OF LOVE / 安室奈美恵 ↔ RESPECT the POWER OF LOVE / 安室奈美惠 [owner tierF tj:6878]
  ['ky', '41089', '19748'], // ky-41089 だんご3兄弟 / 速水けんたろう、他 ↔ だんご3兄弟 / 速水けんたろう/茂森あゆみ/ひまわりキッズ&だんご合唱団 [owner tierF tj:6459]
  ['ky', '41123', '11509'], // ky-41123 ひとりぼっちのハブラシ / 桜庭裕一郎 ↔ ひとりぼっちのハブラシ / 桜庭裕一郎(長瀬智也) [owner tierF tj:25640]
  ['ky', '41155', '21879'], // ky-41155 LOVE 2000 / 安室奈美恵 ↔ LOVE 2000 / 安室奈美惠 [owner tierF tj:25041]
  ['ky', '41206', '27183'], // ky-41206 誰よりも君を愛す / 和田弘とマヒナスターズ、松尾和子 ↔ 誰よりも君を愛す / 松尾和子/和田弘とマヒナスターズ [owner tierF tj:6455]
  ['ky', '41332', '22448'], // ky-41332 I WILL / 安室奈美恵 ↔ I WILL / 安室奈美惠 [owner tierF tj:25169]
  ['ky', '41393', '9678'], // ky-41393 Chase the Chance / 安室奈美恵 ↔ Chase the Chance / 安室奈美惠 [owner tierF tj:25427]
  ['ky', '41503', '9148'], // ky-41503 太陽のSEASON / 安室奈美恵 ↔ 太陽のSEASON / 安室奈美惠 [owner tierF tj:25358]
  ['ky', '41578', '36852'], // ky-41578 For フルーツバスケット / 岡崎律子 ↔ For フルーツバスケット(フルーツバスケット OP) / 岡崎律子 外 [owner tierE tj-25257]
  ['ky', '41743', '30774'], // ky-41743 ALARM / 安室奈美恵 ↔ ALARM / 安室奈美惠 [owner tierF tj:25772]
  ['ky', '41756', '31857'], // ky-41756 SO CRAZY / 安室奈美恵 ↔ SO CRAZY / 安室奈美惠 [owner tierF tj:25637]
  ['ky', '41788', '32720'], // ky-41788 ALL FOR YOU / 安室奈美恵 ↔ ALL FOR YOU / 安室奈美惠 [owner tierF tj:25828]
  ['ky', '41821', '58967'], // ky-41821 暁の車 / FictionJunction YUUKA ↔ 暁の車(機動戦士ガンダムSEED) / Fiction Junction YUUKA [owner tierF tj:25823]
  ['ky', '41932', '10756'], // ky-41932 WANT ME,WANT ME / 安室奈美恵 ↔ Want me, want me / 安室奈美惠 [owner tierF tj:25983]
  ['ky', '42046', '67500'], // ky-42046 マイペース大王 / manzo ↔ マイペース大王(げんしけん OP) / 萬Ｚ(量産型) [owner tierE tj-25988]
  ['ky', '42131', '20003'], // ky-42131 REDEMPTION ("DIRGE of CERBERUS-FINAL FANTASY VII") / Gackt ↔ Redemption / Gackt [owner tierF tj:28115]
  ['ky', '42370', '24536'], // ky-42370 FUNKY TOWN / 安室奈美恵 ↔ FUNKY TOWN / 安室奈美惠 [owner tierF tj:26439]
  ['ky', '42383', '51537'], // ky-42383 EMOTION / 田中理恵 ↔ Emotion(機動戦士ガンダムSEED Character Song) / 田中理恵 [owner tierF tj:26419]
  ['ky', '42390', '125614'], // ky-42390 恋のミクル伝説 / 後藤邑子 ↔ 恋のミクル伝説 / 朝比奈みくる(後藤邑子) [owner tierF tj:26452]
  ['ky', '42423', '62537'], // ky-42423 チチをもげ! / 高橋広樹 ↔ チチをもげ!(金色のガッシュベル!! OST) / パルコ・フォルゴレ(高橋広樹) [owner tierE tj-26007]
  ['ky', '42488', '14062'], // ky-42488 セーラースターソング / 花沢加絵 ↔ セーラースターソング(美少女戦士セーラームーンスターズ OST) / 花澤加繪 [owner tierE tj-26616]
  ['ky', '42572', '162969'], // ky-42572 GUILTY BEAUTY LOVE / 宮野真守 ↔ GUILTY BEAUTY LOVE / 須王環(宮野真守) [owner tierF tj:26576]
  ['ky', '42651', '168735'], // ky-42651 BAMBOO BEAT / 広橋涼/豊口めぐみ/小島幸子/桑島法子/佐藤利奈 ↔ BAMBOO BEAT / 川添珠姫(広橋涼)/千葉紀梨乃(豊口めぐみ)/桑原鞘子(小島幸子)/宮崎都(桑島法子)/東聡莉(佐藤利奈) [owner tierF tj:28015]
  ['ky', '42790', '164310'], // ky-42790 your gravitation / SUN ↔ Your gravitation(瀬戸の花嫁 OST) / 桃井はるこ [owner tierE tj-26754]
  ['ky', '42826', '138579'], // ky-42826 エージェント夜を往く ("THE IDOLM@STER"OST) / 平田宏美 ↔ エージェント夜を往く / 平田宏美 [owner tierF tj:28179]
  ['ky', '43061', '138428'], // ky-43061 炉心融解 / iroha feat.鏡音リン ↔ 炉心融解 / 鏡音リン [owner tierF tj:26903]
  ['ky', '43125', '137780'], // ky-43125 magnet / minato feat.初音ミク・巡音ルカ ↔ Magnet / 初音ミク, 巡音ルカ [owner tierF tj:27029]
  ['ky', '43143', '137779'], // ky-43143 右肩の蝶 / のりP feat.鏡音リン ↔ 右肩の蝶〈リンver.〉 / のりP feat.鏡音リン [owner tierF tj:27038]
  ['ky', '43281', '138115'], // ky-43281 IMITATION BLACK / natsuP feat.神威がくぽ,KAITO,鏡音レン ↔ IMITATION BLACK / natsuP(SCL Project) feat.VanaN'Ice [owner tierF tj:27066]
  ['ky', '43299', '313880'], // ky-43299 天樂 / ゆうゆ feat.鏡音リン ↔ 天樂 / 鏡音リン [owner tierF tj:27035]
  ['ky', '43404', '110661'], // ky-43404 READY!!(M@STER VERSION) ("THE iDOLM@STER"OP) / 765PRO ALLSTARS ↔ Ready!! / 765PRO ALLSTARS [owner tierF tj:28113]
  ['ky', '43515', '106500'], // ky-43515 ハッピーシンセサイザ / EasyPop feat.巡音ルカ、GUMI ↔ ハッピーシンセサイザ / 巡音ルカ,GUMI [owner tierF tj:27289]
  ['ky', '43851', '27017'], // ky-43851 小樽のひとよ / 鶴岡雅義と東京ロマンチカ ↔ 小樽のひとよ / 鶴岡雅儀と東京ロマンチカ [owner tierE tj-6379]
  ['ky', '43868', '726245'], // ky-43868 START:DASH!! / 新田恵海/内田彩/三森すずこ ↔ START:DASH!! / 高坂穂乃果(CV.新田恵海)南ことり(CV.内田彩)園田海未(CV.三森すずこ) [owner tierF tj:27657]
  ['ky', '43877', '119568'], // ky-43877 R.Y.U.S.E.I. / 三代目 J Soul Brothers from EXILE TRIBE ↔ R.Y.U.S.E.I. / 三代目 J Soul Brothers [owner tierF tj:27930]
  ['ky', '43982', '146870'], // ky-43982 自分REST@RT ("THE IDOLM@STER"OST) / 765PRO ALLSTARS ↔ 自分REST@RT(THE IDOLM@STER 2nd OP) / 765PRO ALLSTARS [owner tierE tj-28450]
  ['ky', '44002', '145876'], // ky-44002 CHANGE!!!!(M@STER VERSION) ("THE IDOLM@STER"OP) / 765PRO ALLSTARS ↔ CHANGE!!!!(M@STER VER)(THE IDOLM@STER 2nd OP) / 765PRO ALLSTARS [owner tierE tj-27861]
  ['ky', '44071', '156842'], // ky-44071 好きな人がいること / JY ↔ 好きな人がいること(ドラマ'好きな人がいること' OST) / JY(知英) [owner tierE tj-27962]
  ['ky', '44081', '671782'], // ky-44081 海色 / AKINO from bless4 ↔ 海色(みいろ) / AKINO from bless4 [owner tierF tj:27823]
  ['ky', '44228', '423462'], // ky-44228 ノンファンタジー(いつだって僕らの恋は10センチだった) / LIP×LIP ↔ ノンファンタジー / LIP×LIP(勇次郎・愛蔵/CV:内山昂輝・島崎信長) [owner tierF tj:28792]
  ['ky', '44239', '689913'], // ky-44239 旅立ちのうた / 3年E組 ↔ 旅立ちのうた(暗殺教室 OST) / 3年E組うた担 [owner tierE tj-28802]
  ['ky', '44297', '425317'], // ky-44297 シャンパンゴールド / 木島隆一 ↔ シャンパンゴールド / 伊弉冉一二三(CV.木島隆一) [owner tierF tj:28901]
  ['ky', '44300', '431013'], // ky-44300 BATTLE BATTLE BATTLE / Fling Posse・麻天狼 ↔ BATTLE BATTLE BATTLE / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏)・麻天狼 (CV. 速水奨・木島隆一・伊東健人) [owner tierF tj:28905]
  ['ky', '44303', '429142'], // ky-44303 WAR WAR WAR / Buster Bros!!!・MAD TRIGGER CREW ↔ WAR WAR WAR / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平)・MAD TRIGGER CREW(CV.浅沼晋太郎・駒田航・神尾晋一郎) [owner tierF tj:28893]
  ['ky', '44304', '429143'], // ky-44304 IKEBUKURO WEST GAME PARK / Buster Bros!!! ↔ IKEBUKURO WEST GAME PARK / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平) [owner tierF tj:28894]
  ['ky', '44308', '431015'], // ky-44308 Shibuya Marble Texture-PCCS- / Fling Posse ↔ Shibuya Marble Texture-PCCS- / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏) [owner tierF tj:28917]
  ['ky', '44312', '431014'], // ky-44312 Shinjuku Style ~笑わすな~ / 麻天狼 ↔ Shinjuku Style~笑わすな~ / 摩天狼 [owner tierF tj:28930]
  ['ky', '44318', '429144'], // ky-44318 Yokohama Walker / MAD TRIGGER CREW ↔ Yokohama Walker / MAD TRIGGER CREW(CV.浅沼晋太郎・駒田航・神尾晋一郎) [owner tierF tj:28924]
  ['ky', '44338', '434190'], // ky-44338 DEATH RESPECT / MAD TRIGGER CREW・麻天狼 ↔ DEATH RESPECT / MAD TRIGGER CREW (CV.浅沼晋太郎・駒田航・神尾晋一郎)・麻天狼 (CV.速水奨・木島隆一・伊東健人) [owner tierF tj:28936]
  ['ky', '44342', '136105'], // ky-44342 蒼い鳥 ("THE IDOLM@STER"OST) / 今井麻美 ↔ 蒼い鳥 / 今井麻美 [owner tierF tj:28969]
  ['ky', '44356', '425316'], // ky-44356 チグリジア / 伊東健人 ↔ チグリジア / 観音坂独歩(CV.伊東健人) [owner tierF tj:28982]
  ['ky', '44615', '424125'], // ky-44615 Reason!! / 315 STARS ↔ Reason!!(THE IDOLM@STER SideM OP) / 315 STARS [owner tierE tj-28998]
  ['ky', '44649', '488132'], // ky-44649 うやむや / SixTONES ↔ うやむや(YouTube Ver.) / SixTONES [owner tierE tj-68384]
  ['ky', '44676', '489561'], // ky-44676 Black Journey / Fling Posse ↔ Black Journey / Fling Posse (CV. 白井悠介・斉藤壮馬・野津山幸宏) [owner tierF tj:68412]
  ['ky', '44751', '495453'], // ky-44751 おもかげ (produced by Vaundy) / milet×Aimer×幾田りら ↔ おもかげ / milet & Aimer & 幾田りら(produced by Vaundy) [owner tierE tj-25017]
  ['ky', '44791', '489049'], // ky-44791 Re:start!!! / Buster Bros!!! ↔ Re:start!!! / Buster Bros!!!(CV.木村昴・石谷春貴・天崎滉平) [owner tierF tj:68594]
  ['ky', '44799', '489421'], // ky-44799 開眼 / Bad Ass Temple ↔ 開眼 / Bad Ass Temple(CV:葉山翔太・榊原優希・竹内栄治) [owner tierF tj:68593]
  ['ky', '57811', '613071'], // ky-57811 愛じゃない / ダズビー ↔ 愛じゃない / DAZBEE [owner tierE tj-52800]
  ['ky', '75839', '487547'], // ky-75839 Life Is Beautiful ("Paradox Live"OST) / The Cat's Whiskers ↔ Life Is Beautiful(プロジェクト 'Paradox Live' ソング) / The Cat's Whiskers [owner tierE tj-68889]
  ['ky', '75840', '487548'], // ky-75840 FRE△KOUT ("Paradox Live"OST) / BAE ↔ FRE△KOUT(プロジェクト 'Paradox Live' ソング) / BAE [owner tierE tj-68890]
  ['ky', '75858', '487546'], // ky-75858 Back Off ("Paradox Live"OST) / cozmez ↔ Back Off / cozmez [owner tierF tj:68913]
  ['ky', '75876', '618669'], // ky-75876 命短し尽くせよ奴隷 / 福原かつみ ↔ 命短し尽くせよ奴隷 / 本橋依央利 [owner tierF tj:68935]
  ['ky', '75877', '618670'], // ky-75877 秩序宣言 / 山中真尋 ↔ 秩序宣言 / 草薙理解 [owner tierF tj:68936]
  ['ky', '75891', '619503'], // ky-75891 Charisma Battle Anthem / 小野友樹 feat.六人のカリスマ ↔ Charisma Battle Anthem / 伊藤ふみや feat. 六人のカリスマ [owner tierF tj:68948]
  ['ky', '75897', '618642'], // ky-75897 When The Charisma Go Marching In / 小野友樹 ↔ When The Charisma Go Marching In / 伊藤ふみや [owner tierF tj:68959]
  ['ky', '75898', '618646'], // ky-75898 LOVE MYSELF / 大河元気 ↔ LOVE MYSELF / テラ [owner tierF tj:68962]
  ['tj', '26145', '1546'], // tj-26145 忘れていいの / 小川知子,谷村新司 ↔ 忘れていいの -愛の幕切れ- / 谷村新司/小川知子 [owner tierF ky:40449]
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_3WAY_ATTACH_PAIR_COUNT = 85;

export const REVIEWED_TIER_F_3WAY_ATTACH_JOYS_BY_VENDOR_NUMBER = new Map<string, Set<string>>();
for (const [vendor, number, joysound] of REVIEWED_TIER_F_3WAY_ATTACH_PAIRS) {
  const key = `${vendor}:${number}`;
  const existing = REVIEWED_TIER_F_3WAY_ATTACH_JOYS_BY_VENDOR_NUMBER.get(key);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_F_3WAY_ATTACH_JOYS_BY_VENDOR_NUMBER.set(key, new Set([joysound]));
}

function assertReviewedTierF3wayAttachInvariant(): void {
  // (1) exact length.
  if (
    REVIEWED_TIER_F_3WAY_ATTACH_PAIRS.length !== EXPECTED_REVIEWED_TIER_F_3WAY_ATTACH_PAIR_COUNT
  ) {
    throw new Error(
      `Tier F 3-way attach table must contain exactly ${EXPECTED_REVIEWED_TIER_F_3WAY_ATTACH_PAIR_COUNT} pairs`,
    );
  }

  // Reverse index: every joysound owned by an existing Tier E/F pair → owner
  // vendor. Drives assertions (4) orphan and (5) vendor-distinctness.
  const ownerVendorByJoysound = new Map<string, NonJoysoundVendor>();
  for (const joys of REVIEWED_TIER_E_JOYS_BY_TJ.values())
    for (const j of joys) ownerVendorByJoysound.set(j, 'tj');
  for (const [key, joys] of REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER) {
    const vendor = key.split(':')[0] as NonJoysoundVendor;
    for (const j of joys) ownerVendorByJoysound.set(j, vendor);
  }
  // Existing reviewed TARGET cells the attach must not collide with: every Tier
  // F vendor:number plus every Tier E tj number (as `tj:<n>`).
  const existingTargets = new Set<string>();
  for (const key of REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER.keys()) existingTargets.add(key);
  for (const tj of REVIEWED_TIER_E_JOYS_BY_TJ.keys()) existingTargets.add(`tj:${tj}`);

  const vendorNumbers = new Set<string>();
  const joys = new Set<string>();
  for (const [vendor, number, joysound] of REVIEWED_TIER_F_3WAY_ATTACH_PAIRS) {
    const vendorNumberKey = `${vendor}:${number}`;
    // (2) attach vendor:number unique + cross-exclusive with existing targets.
    if (vendorNumbers.has(vendorNumberKey))
      throw new Error(`Tier F 3-way attach duplicate target cell: ${vendorNumberKey}`);
    if (existingTargets.has(vendorNumberKey))
      throw new Error(
        `Tier F 3-way attach target cell collides with an existing reviewed target: ${vendorNumberKey}`,
      );
    // (3) JOYSOUND unique within the attach table (one bridge per J).
    if (joys.has(joysound))
      throw new Error(`Tier F 3-way attach duplicate JOYSOUND number: ${joysound}`);
    // (4) orphan guard: every attach J must be owned by an existing E/F pair.
    const ownerVendor = ownerVendorByJoysound.get(joysound);
    if (ownerVendor === undefined)
      throw new Error(
        `Tier F 3-way attach JOYSOUND ${joysound} has no owning Tier E/F pair (orphan attach)`,
      );
    // (5) attach vendor must differ from the owning pair's vendor.
    if (ownerVendor === vendor)
      throw new Error(
        `Tier F 3-way attach vendor ${vendor} equals the owning vendor for JOYSOUND ${joysound}`,
      );
    vendorNumbers.add(vendorNumberKey);
    joys.add(joysound);
  }
}

assertReviewedTierF3wayAttachInvariant();
