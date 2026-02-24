// migrate.js — Roda migrations automaticamente no Railway
// SQL embutido diretamente (o deploy do backend não inclui a pasta /database)
require('dotenv').config();
const { Pool } = require('pg');

// ── Aguarda o PostgreSQL aceitar conexões (Railway demora alguns segundos) ──
async function waitForDB(pool, maxAttempts = 20, intervalMs = 3000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1');
      console.log(`✔ PostgreSQL pronto (tentativa ${i})`);
      return true;
    } catch (err) {
      console.log(`⏳ Aguardando PostgreSQL... (${i}/${maxAttempts}) — ${err.message}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return false;
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.log('ℹ DATABASE_URL não definida — pulando migrate (modo local/Termux)');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });

  try {
    console.log('🔌 Conectando ao PostgreSQL...');
    const ready = await waitForDB(pool);
    if (!ready) {
      console.error('❌ PostgreSQL não ficou disponível. Abortando migrate.');
      process.exit(1);
    }

    const client = await pool.connect();
    try {
      // Verifica se o banco já foi inicializado
      const { rows } = await client.query(`
        SELECT COUNT(*)::int as count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'roles'
      `);

      if (rows[0].count > 0) {
        console.log('✔ Banco já inicializado — pulando migrations.');
        return;
      }

      console.log('🔧 Aplicando schema inicial...');
      await client.query(SCHEMA_SQL);
      console.log('✔ Schema aplicado');

      console.log('🌱 Inserindo dados iniciais...');
      await client.query(SEED_SQL);
      console.log('✔ Seeds inseridos');

      console.log('✅ Banco pronto!');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Erro na migration:', err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── SQL embutido ────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
-- ============================================================
-- CraftMind Nexus - Schema v2.0 - PostgreSQL
-- ============================================================

-- Tipos ENUM
CREATE TYPE role_name       AS ENUM ('admin', 'secretary', 'teacher', 'student');
CREATE TYPE question_type   AS ENUM ('multiple_choice', 'true_false', 'open', 'code', 'design');
CREATE TYPE difficulty_type AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE assignment_type AS ENUM ('exam', 'quiz', 'practice_code', 'practice_design', 'homework');
CREATE TYPE assign_status   AS ENUM ('draft', 'published', 'closed');
CREATE TYPE sub_status      AS ENUM ('in_progress', 'submitted', 'graded', 'late');
CREATE TYPE code_lang       AS ENUM ('java', 'javascript', 'python');
CREATE TYPE compile_status  AS ENUM ('pending', 'success', 'error', 'timeout');
CREATE TYPE run_status      AS ENUM ('pending', 'success', 'error', 'timeout', 'wrong_answer');
CREATE TYPE xp_source       AS ENUM ('submission', 'bonus', 'achievement', 'attendance', 'penalty');
CREATE TYPE notif_type      AS ENUM ('info', 'success', 'warning', 'assignment', 'grade');
CREATE TYPE mc_act_type     AS ENUM ('quiz_start', 'quiz_complete', 'code_submit', 'design_submit', 'assignment_open');

-- Trigger de updated_at reutilizável
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ── ROLES ──────────────────────────────────────────────────
CREATE TABLE roles (
    id          SERIAL PRIMARY KEY,
    name        role_name NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO roles (name, description) VALUES
('admin',     'Acesso total ao sistema'),
('secretary', 'Gestão escolar e relatórios'),
('teacher',   'Criação de conteúdo e avaliação'),
('student',   'Realização de atividades');

-- ── USERS ──────────────────────────────────────────────────
CREATE TABLE users (
    id                  SERIAL PRIMARY KEY,
    username            VARCHAR(50)  NOT NULL UNIQUE,
    email               VARCHAR(100) UNIQUE,
    password_hash       VARCHAR(255) NOT NULL,
    role_id             INTEGER      NOT NULL REFERENCES roles(id),
    minecraft_uuid      VARCHAR(36)  UNIQUE,
    minecraft_username  VARCHAR(16),
    display_name        VARCHAR(100),
    avatar_url          VARCHAR(500),
    bio                 TEXT,
    is_active           BOOLEAN      DEFAULT TRUE,
    last_login          TIMESTAMPTZ  NULL,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
);
CREATE TRIGGER trg_users_upd BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
    id          VARCHAR(128) PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(512) NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ  NOT NULL,
    ip_address  VARCHAR(45),
    user_agent  TEXT,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── SCHOOL STRUCTURE ───────────────────────────────────────
CREATE TABLE school_years (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    level       VARCHAR(20) NOT NULL CHECK (level IN ('fundamental','medio')),
    year_number INTEGER     NOT NULL,
    is_active   BOOLEAN     DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO school_years (name, level, year_number) VALUES
('6º Ano - Ensino Fundamental', 'fundamental', 6),
('7º Ano - Ensino Fundamental', 'fundamental', 7),
('8º Ano - Ensino Fundamental', 'fundamental', 8),
('9º Ano - Ensino Fundamental', 'fundamental', 9),
('1º Ano - Ensino Médio',       'medio',       1),
('2º Ano - Ensino Médio',       'medio',       2),
('3º Ano - Ensino Médio',       'medio',       3);

CREATE TABLE subjects (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    code        VARCHAR(20)  NOT NULL UNIQUE,
    level       VARCHAR(20)  NOT NULL DEFAULT 'ambos' CHECK (level IN ('fundamental','medio','ambos')),
    color       VARCHAR(7)   DEFAULT '#3B82F6',
    icon        VARCHAR(50)  DEFAULT 'book',
    description TEXT,
    is_active   BOOLEAN      DEFAULT TRUE,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);
INSERT INTO subjects (name, code, level, color, icon) VALUES
('Matemática',        'MAT',  'ambos',       '#EF4444', 'calculator'),
('Língua Portuguesa', 'PORT', 'ambos',       '#3B82F6', 'book-open'),
('Ciências',          'CIEN', 'fundamental', '#22C55E', 'flask'),
('História',          'HIST', 'ambos',       '#F59E0B', 'landmark'),
('Geografia',         'GEO',  'ambos',       '#14B8A6', 'globe'),
('Inglês',            'ING',  'ambos',       '#8B5CF6', 'languages'),
('Artes',             'ART',  'fundamental', '#EC4899', 'palette'),
('Educação Física',   'EDF',  'fundamental', '#F97316', 'activity'),
('Física',            'FIS',  'medio',       '#6366F1', 'zap'),
('Química',           'QUIM', 'medio',       '#10B981', 'atom'),
('Biologia',          'BIO',  'medio',       '#84CC16', 'dna'),
('Filosofia',         'FIL',  'medio',       '#94A3B8', 'brain'),
('Sociologia',        'SOC',  'medio',       '#F472B6', 'users'),
('Literatura',        'LIT',  'medio',       '#A78BFA', 'feather'),
('Redação',           'RED',  'medio',       '#60A5FA', 'pencil');

CREATE TABLE classes (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    code            VARCHAR(20)  NOT NULL UNIQUE,
    school_year_id  INTEGER      NOT NULL REFERENCES school_years(id),
    academic_year   INTEGER      NOT NULL DEFAULT EXTRACT(YEAR FROM NOW())::INT,
    max_students    INTEGER      DEFAULT 40,
    is_active       BOOLEAN      DEFAULT TRUE,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE TABLE class_students (
    id          SERIAL PRIMARY KEY,
    class_id    INTEGER NOT NULL REFERENCES classes(id)  ON DELETE CASCADE,
    student_id  INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    enrolled_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (class_id, student_id)
);
CREATE TABLE class_teachers (
    id          SERIAL PRIMARY KEY,
    class_id    INTEGER NOT NULL REFERENCES classes(id)   ON DELETE CASCADE,
    teacher_id  INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id),
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (class_id, teacher_id, subject_id)
);

-- ── QUESTIONS ──────────────────────────────────────────────
CREATE TABLE questions (
    id              SERIAL PRIMARY KEY,
    teacher_id      INTEGER       NOT NULL REFERENCES users(id),
    subject_id      INTEGER       NOT NULL REFERENCES subjects(id),
    school_year_id  INTEGER       NOT NULL REFERENCES school_years(id),
    title           VARCHAR(500)  NOT NULL,
    content         TEXT          NOT NULL,
    question_type   question_type NOT NULL,
    difficulty      difficulty_type NOT NULL DEFAULT 'medium',
    points          NUMERIC(5,2)  DEFAULT 10.00,
    time_limit_seconds INTEGER    DEFAULT 0,
    explanation     TEXT,
    tags            JSONB,
    is_active       BOOLEAN       DEFAULT TRUE,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE TRIGGER trg_questions_upd BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE question_options (
    id            SERIAL PRIMARY KEY,
    question_id   INTEGER  NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_letter CHAR(1)  NOT NULL,
    content       TEXT     NOT NULL,
    is_correct    BOOLEAN  DEFAULT FALSE,
    order_index   INTEGER  DEFAULT 0
);

-- ── ASSIGNMENTS ────────────────────────────────────────────
CREATE TABLE assignments (
    id                  SERIAL PRIMARY KEY,
    teacher_id          INTEGER         NOT NULL REFERENCES users(id),
    class_id            INTEGER         NOT NULL REFERENCES classes(id),
    subject_id          INTEGER         NOT NULL REFERENCES subjects(id),
    title               VARCHAR(255)    NOT NULL,
    description         TEXT,
    type                assignment_type NOT NULL,
    status              assign_status   DEFAULT 'draft',
    max_score           NUMERIC(5,2)    DEFAULT 100.00,
    xp_reward           INTEGER         DEFAULT 100,
    time_limit_minutes  INTEGER         DEFAULT 0,
    starts_at           TIMESTAMPTZ     NULL,
    ends_at             TIMESTAMPTZ     NULL,
    instructions        TEXT,
    config              JSONB,
    created_at          TIMESTAMPTZ     DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     DEFAULT NOW()
);
CREATE TRIGGER trg_assignments_upd BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE assignment_questions (
    id              SERIAL PRIMARY KEY,
    assignment_id   INTEGER     NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    question_id     INTEGER     NOT NULL REFERENCES questions(id),
    order_index     INTEGER     DEFAULT 0,
    points_override NUMERIC(5,2) NULL
);

-- ── SUBMISSIONS ────────────────────────────────────────────
CREATE TABLE submissions (
    id                  SERIAL PRIMARY KEY,
    assignment_id       INTEGER    NOT NULL REFERENCES assignments(id),
    student_id          INTEGER    NOT NULL REFERENCES users(id),
    status              sub_status DEFAULT 'in_progress',
    score               NUMERIC(5,2) NULL,
    xp_earned           INTEGER    DEFAULT 0,
    started_at          TIMESTAMPTZ DEFAULT NOW(),
    submitted_at        TIMESTAMPTZ NULL,
    graded_at           TIMESTAMPTZ NULL,
    graded_by           INTEGER    NULL REFERENCES users(id),
    feedback            TEXT,
    time_spent_seconds  INTEGER    DEFAULT 0,
    minecraft_world     VARCHAR(100),
    UNIQUE (assignment_id, student_id)
);

CREATE TABLE submission_answers (
    id              SERIAL PRIMARY KEY,
    submission_id   INTEGER     NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    question_id     INTEGER     NOT NULL REFERENCES questions(id),
    answer_text     TEXT,
    selected_option CHAR(1),
    is_correct      BOOLEAN     NULL,
    score_earned    NUMERIC(5,2) DEFAULT 0,
    answered_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (submission_id, question_id)
);

-- ── CODE SUBMISSIONS ───────────────────────────────────────
CREATE TABLE code_submissions (
    id                  SERIAL PRIMARY KEY,
    submission_id       INTEGER        NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    language            code_lang      NOT NULL DEFAULT 'python',
    source_code         TEXT           NOT NULL,
    stdin               TEXT,
    expected_output     TEXT,
    actual_output       TEXT,
    execution_time_ms   INTEGER,
    memory_used_kb      INTEGER,
    compile_status      compile_status DEFAULT 'pending',
    run_status          run_status     DEFAULT 'pending',
    error_message       TEXT,
    submitted_at        TIMESTAMPTZ    DEFAULT NOW()
);

-- ── DESIGN / PIXEL STUDIO ──────────────────────────────────
CREATE TABLE design_submissions (
    id              SERIAL PRIMARY KEY,
    submission_id   INTEGER  NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    canvas_data     JSONB    NOT NULL,
    png_url         VARCHAR(500),
    teacher_rating  INTEGER  NULL CHECK (teacher_rating BETWEEN 0 AND 100),
    teacher_comment TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── XP & GAMIFICATION ─────────────────────────────────────
CREATE TABLE student_xp (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    total_xp    INTEGER DEFAULT 0,
    level       INTEGER DEFAULT 1,
    class_rank  INTEGER NULL,
    year_rank   INTEGER NULL,
    school_rank INTEGER NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER trg_xp_upd BEFORE UPDATE ON student_xp FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE xp_transactions (
    id          SERIAL PRIMARY KEY,
    student_id  INTEGER   NOT NULL REFERENCES users(id),
    xp_amount   INTEGER   NOT NULL,
    source_type xp_source NOT NULL,
    source_id   INTEGER   NULL,
    description VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE achievements (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(50)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon            VARCHAR(100),
    xp_reward       INTEGER DEFAULT 0,
    condition_type  VARCHAR(50),
    condition_value INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO achievements (code, name, description, icon, xp_reward, condition_type, condition_value) VALUES
('FIRST_SUBMISSION', 'Primeira Entrega',   'Completou sua primeira atividade',           'star',    50,  'submissions_count',  1),
('PERFECT_SCORE',    'Nota Perfeita',       'Tirou 100 em uma atividade',                 'trophy',  200, 'perfect_score',      1),
('STREAK_7',         'Uma Semana Dedicado', 'Acessou o servidor 7 dias seguidos',         'fire',    150, 'login_streak',       7),
('CODE_MASTER',      'Mestre do Código',    'Completou 10 atividades de programação',     'code',    300, 'code_submissions',   10),
('PIXEL_ARTIST',     'Artista Pixel',       'Completou 5 atividades de design',           'palette', 200, 'design_submissions', 5),
('HONOR_ROLL',       'Honra ao Mérito',     'Média acima de 9.0 no bimestre',             'medal',   500, 'average_score',      90);

CREATE TABLE student_achievements (
    id              SERIAL PRIMARY KEY,
    student_id      INTEGER NOT NULL REFERENCES users(id),
    achievement_id  INTEGER NOT NULL REFERENCES achievements(id),
    earned_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (student_id, achievement_id)
);

-- ── GRADES ────────────────────────────────────────────────
CREATE TABLE grades (
    id            SERIAL PRIMARY KEY,
    student_id    INTEGER     NOT NULL REFERENCES users(id),
    class_id      INTEGER     NOT NULL REFERENCES classes(id),
    subject_id    INTEGER     NOT NULL REFERENCES subjects(id),
    bimester      INTEGER     NOT NULL CHECK (bimester BETWEEN 1 AND 4),
    academic_year INTEGER     NOT NULL,
    grade         NUMERIC(5,2),
    absences      INTEGER     DEFAULT 0,
    observations  TEXT,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (student_id, class_id, subject_id, bimester, academic_year)
);

-- ── MINECRAFT SYNC ────────────────────────────────────────
CREATE TABLE minecraft_sessions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER     NOT NULL REFERENCES users(id),
    minecraft_uuid  VARCHAR(36) NOT NULL,
    server_name     VARCHAR(100),
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    left_at         TIMESTAMPTZ NULL,
    is_active       BOOLEAN     DEFAULT TRUE
);
CREATE TABLE minecraft_activity (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER     NOT NULL REFERENCES users(id),
    activity_type   mc_act_type NOT NULL,
    assignment_id   INTEGER     NULL,
    data            JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDIT & NOTIFICATIONS ─────────────────────────────────
CREATE TABLE activity_logs (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NULL,
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INTEGER,
    details     JSONB,
    ip_address  VARCHAR(45),
    user_agent  TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE notifications (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(255) NOT NULL,
    message     TEXT         NOT NULL,
    type        notif_type   DEFAULT 'info',
    is_read     BOOLEAN      DEFAULT FALSE,
    action_url  VARCHAR(500),
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── QUESTION TEMPLATES (banco de questões de exemplo) ──────
CREATE TABLE question_templates (
    id              SERIAL PRIMARY KEY,
    subject_id      INTEGER       NOT NULL REFERENCES subjects(id),
    school_year_id  INTEGER       NOT NULL REFERENCES school_years(id),
    topic           VARCHAR(255)  NOT NULL,
    content         TEXT          NOT NULL,
    type            question_type NOT NULL,
    difficulty      difficulty_type NOT NULL,
    correct_option  CHAR(1),
    option_a        TEXT,
    option_b        TEXT,
    option_c        TEXT,
    option_d        TEXT,
    option_e        TEXT,
    explanation     TEXT
);

-- ── INDEXES ───────────────────────────────────────────────
CREATE INDEX idx_users_mc_uuid      ON users(minecraft_uuid);
CREATE INDEX idx_users_role         ON users(role_id);
CREATE INDEX idx_subs_student       ON submissions(student_id);
CREATE INDEX idx_subs_assignment    ON submissions(assignment_id);
CREATE INDEX idx_assignments_class  ON assignments(class_id);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE INDEX idx_xp_transactions    ON xp_transactions(student_id);
CREATE INDEX idx_grades_student     ON grades(student_id, academic_year);
CREATE INDEX idx_notif_user         ON notifications(user_id, is_read);
CREATE INDEX idx_logs_user          ON activity_logs(user_id);
CREATE INDEX idx_logs_created       ON activity_logs(created_at);
`;

const SEED_SQL = `
-- ============================================================
-- CraftMind Nexus - Seed Data - PostgreSQL
-- ============================================================

-- Usuários padrão (senha: Admin@123)
INSERT INTO users (username, email, password_hash, role_id, display_name) VALUES
('admin',        'admin@craftmind.edu.br',      '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMlJbekRaLKEbr0XGnGfMGSlaa', 1, 'Administrador'),
('secretaria',   'secretaria@craftmind.edu.br', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMlJbekRaLKEbr0XGnGfMGSlaa', 2, 'Secretaria'),
('prof_joao',    'joao@craftmind.edu.br',        '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMlJbekRaLKEbr0XGnGfMGSlaa', 3, 'Prof. João Silva'),
('aluno_teste',  'aluno@craftmind.edu.br',       '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMlJbekRaLKEbr0XGnGfMGSlaa', 4, 'Aluno Teste');

-- Turmas de exemplo
INSERT INTO classes (name, code, school_year_id, academic_year) VALUES
('6A - Turma A', '6EFA', 1, 2025),
('7A - Turma A', '7EFA', 2, 2025),
('8A - Turma A', '8EFA', 3, 2025),
('9A - Turma A', '9EFA', 4, 2025),
('1EM-A',        '1EMA', 5, 2025),
('2EM-A',        '2EMA', 6, 2025),
('3EM-A',        '3EMA', 7, 2025);

-- XP inicial para aluno_teste (id=4)
INSERT INTO student_xp (student_id, total_xp, level) VALUES (4, 0, 1);

-- ── Questões Matemática - 6º Ano ──────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(1,1,'Frações','Qual é o resultado de 1/2 + 1/4?','multiple_choice','easy','B','1/6','3/4','2/6','1/8','MMC(2,4)=4. Então 2/4 + 1/4 = 3/4'),
(1,1,'Números Naturais','Quanto é 15 × 12?','multiple_choice','easy','C','165','170','180','185','15×12 = 150+30 = 180'),
(1,1,'Geometria','Área de um retângulo base 8cm, altura 5cm?','multiple_choice','medium','A','40 cm²','13 cm²','26 cm²','45 cm²','Área = 8×5 = 40 cm²'),
(1,1,'Divisibilidade','O número 144 é divisível por?','multiple_choice','medium','D','Apenas 2','Apenas 3','2 e 5','2, 3 e 4','144÷2=72; 144÷3=48; 144÷4=36'),
(1,1,'MMC e MDC','Qual é o MDC(12, 18)?','multiple_choice','hard','B','3','6','12','36','Maior divisor comum de 12 e 18 é 6');

-- ── Questões Português - 6º Ano ───────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(2,1,'Ortografia','Qual a forma correta?','multiple_choice','easy','C','Excessão','Exeção','Exceção','Excepção','Correto: Exceção'),
(2,1,'Classes Gramaticais','Em "O menino correu rapidamente", "rapidamente" é um:','multiple_choice','easy','B','Adjetivo','Advérbio','Substantivo','Pronome','Advérbio de modo'),
(2,1,'Pontuação','Comprei frutas_uvas, maçãs e peras_no mercado.','multiple_choice','medium','C','ponto e vírgula / ponto e vírgula','vírgula / ponto','dois-pontos / vírgula','travessão / reticências','Dois-pontos introduzem enumeração');

-- ── Questões Ciências - 6º Ano ────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(3,1,'Células','A unidade básica da vida é:','multiple_choice','easy','A','A célula','O átomo','A molécula','O tecido','Menor unidade estrutural e funcional'),
(3,1,'Sistemas do Corpo','Qual órgão filtra o sangue?','multiple_choice','easy','C','Coração','Pulmão','Rim','Fígado','Rins filtram o sangue'),
(3,1,'Ecossistemas','O que são produtores em um ecossistema?','multiple_choice','medium','B','Animais que caçam','Seres que fazem fotossíntese','Decompositores','Parasitas','Autotróficos que realizam fotossíntese');

-- ── Questões Matemática - 9º Ano ──────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(1,4,'Equação 2º Grau','Resolva: x² - 5x + 6 = 0','multiple_choice','medium','C','x=1 e x=6','x=-2 e x=-3','x=2 e x=3','x=-1 e x=-6','Δ=1; x=(5±1)/2 → x=3 e x=2'),
(1,4,'Pitágoras','Catetos 3 e 4. Hipotenusa:','multiple_choice','easy','B','√7','5','7','√14','h²=9+16=25 → h=5'),
(1,4,'Geometria Analítica','Distância A(1,1) a B(4,5):','multiple_choice','hard','D','3','4','√7','5','d=√(9+16)=5');

-- ── Questões Física - 1º EM ───────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(9,5,'Cinemática','Carro percorre 120km em 2h. Velocidade média:','multiple_choice','easy','A','60 km/h','240 km/h','122 km/h','118 km/h','v=120/2=60 km/h'),
(9,5,'Leis de Newton','A 1ª Lei de Newton é chamada de:','multiple_choice','easy','C','Lei da Ação e Reação','Lei da Força','Princípio da Inércia','Lei da Gravitação','Corpo em repouso tende a permanecer em repouso'),
(9,5,'Energia','Energia cinética: 2kg a 10m/s:','multiple_choice','medium','B','20 J','100 J','200 J','50 J','Ec=mv²/2=2×100/2=100J');

-- ── Questões Química - 1º EM ──────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(10,5,'Tabela Periódica','Símbolo do ouro na tabela periódica:','multiple_choice','easy','C','Or','Go','Au','Og','Au vem do latim Aurum'),
(10,5,'Estados da Matéria','Sólido para gasoso sem passar pelo líquido:','multiple_choice','medium','B','Evaporação','Sublimação','Fusão','Condensação','Sublimação: passagem direta sólido→gás'),
(10,5,'Ligações Químicas','Ligação em H₂:','multiple_choice','medium','A','Covalente apolar','Covalente polar','Iônica','Metálica','Dois H iguais, sem diferença de eletronegatividade');

-- ── Questões Biologia - 2º EM ─────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(11,6,'Genética','Código genético armazenado em:','multiple_choice','easy','B','Proteínas','DNA','RNA','Ribossomos','DNA armazena a informação genética'),
(11,6,'Evolução','Evolução por seleção natural proposta por:','multiple_choice','easy','A','Charles Darwin','Gregor Mendel','Louis Pasteur','Lamarck','Darwin - A Origem das Espécies, 1859'),
(11,6,'Ecologia','Simbiose mutualística:','multiple_choice','medium','C','Uma beneficia, outra prejudicada','Uma beneficia, outra neutra','Ambas se beneficiam','Ambas prejudicadas','Mutualismo: ambas se beneficiam');

-- ── Questões História - 8º Ano ────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(4,3,'Revolução Industrial','A Revolução Industrial começou em:','multiple_choice','easy','B','França','Inglaterra','Alemanha','Estados Unidos','Início na Inglaterra, séc. XVIII'),
(4,3,'Imperialismo','Principal motivação do imperialismo séc. XIX:','multiple_choice','medium','A','Expansão de mercados e matérias-primas','Difusão da democracia','Combate à escravidão','Exploração turística','Garantir matérias-primas e mercados');

-- ── Questões Filosofia - 2º EM ────────────────────────────
INSERT INTO question_templates (subject_id, school_year_id, topic, content, type, difficulty, correct_option, option_a, option_b, option_c, option_d, explanation) VALUES
(12,6,'Filosofia Grega','"Conhece-te a ti mesmo" é atribuído a:','multiple_choice','easy','C','Platão','Aristóteles','Sócrates','Tales de Mileto','Frase inscrita no Oráculo de Delfos'),
(12,6,'Ética','Imperativo categórico de Kant:','multiple_choice','hard','B','Conforme nossos desejos','Conforme lei que pudesse ser universal','Para maximizar o prazer','Segundo o que Deus determina','Age conforme máxima universalizável');
`;

migrate();
