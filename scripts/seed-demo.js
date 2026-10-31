require('dotenv').config();

const PHASES = [
  {
    name: 'Préparation du site & terrassement',
    tasks: ['Débroussaillage', 'Implantation & relevé', 'Terrassement au niveau']
  },
  {
    name: 'Fondations & infrastructure',
    tasks: ['Fouilles des semelles', 'Pose du ferraillage', 'Coulage du béton']
  },
  {
    name: 'Ossature (structure)',
    tasks: ['Poteaux', 'Poutres', 'Coulage de la dalle']
  },
  {
    name: 'Murs & maçonnerie',
    tasks: ['Blocs du rez-de-chaussée', 'Linteaux', "Blocs de l'étage"]
  },
  {
    name: 'Toiture & charpente',
    tasks: ['Assemblage de la charpente', 'Tôles de toiture', 'Gouttières']
  },
  {
    name: 'Lots techniques (plomberie, électricité)',
    tasks: ['Plomberie (gros œuvre)', 'Gaines électriques', 'Essais']
  },
  {
    name: 'Finitions & menuiserie',
    tasks: ['Enduit', 'Carrelage', 'Portes & fenêtres', 'Peinture']
  },
  {
    name: 'Contrôle & réception',
    tasks: ['Liste des réserves', 'Inspection finale', 'Réception & remise des clés']
  }
];

const baseUrl = (process.env.BTP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const username = process.env.BTP_ADMIN_USERNAME;
const password = process.env.BTP_ADMIN_PASSWORD;
const force = process.argv.includes('--force');

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.cause?.code === 'ENOTFOUND' ||
        error.cause?.code === 'ETIMEDOUT') {
      throw new Error(`Impossible de joindre ${baseUrl}. Démarrez l'application avec "npm start" dans un autre terminal et vérifiez BTP_BASE_URL.`);
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (path === '/api/login' && response.status === 401) {
    throw new Error('Connexion admin refusée. Créez d’abord le compte administrateur dans le navigateur, puis vérifiez BTP_ADMIN_USERNAME et BTP_ADMIN_PASSWORD dans .env.');
  }
  if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
  return { data, response };
}

async function main() {
  if (!username || !password) {
    throw new Error('Définissez BTP_ADMIN_USERNAME et BTP_ADMIN_PASSWORD pour le compte admin.');
  }

  const { response: loginResponse } = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const cookie = (loginResponse.headers.get('set-cookie') || '').match(/(?:^|,\s*)sid=([^;]+)/)?.[1];
  if (!cookie) throw new Error('Connexion réussie, mais le cookie de session est absent.');
  const headers = { 'Content-Type': 'application/json', Cookie: `sid=${cookie}` };

  const { data: current } = await request('/api/state', { headers });
  if (current.json && !force) {
    throw new Error('Un projet existe déjà. Rien n’a été modifié. Ajoutez --force pour le remplacer.');
  }

  const by = username;
  const phases = PHASES.map((phase, phaseIndex) => ({
    name: phase.name,
    status: phaseIndex < 2 ? 'Completed' : phaseIndex === 2 ? 'In Progress' : 'Not Started',
    ts: '',
    as: phaseIndex < 2 ? '2026-06-01' : phaseIndex === 2 ? '2026-07-22' : '',
    te: '',
    ae: phaseIndex < 2 ? '2026-07-20' : '',
    tasks: phase.tasks.map((task, taskIndex) => ({
      id: `demo-${phaseIndex + 1}-${taskIndex + 1}`,
      t: task,
      d: phaseIndex < 2 || (phaseIndex === 2 && taskIndex === 0)
    })),
    photos: [],
    notes: []
  }));
  const project = {
    proj: {
      name: 'Villa R+1 Bonamoussadi',
      loc: 'Douala, Cameroun',
      start: '2026-06-01',
      end: '2027-03-31',
      budget: 45000000
    },
    phases,
    ev: [
      { d: '2026-06-01', t: 'Début de la préparation du site', by },
      { d: '2026-07-20', t: 'Fondations terminées', by }
    ]
  };

  await request('/api/state', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ json: JSON.stringify(project), baseVersion: current.version })
  });

  let index = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      const probable = [3, 5, 4, 6, 2, 7][index++ % 6];
      const optimistic = Math.max(1, Math.round(probable * 0.6 * 2) / 2);
      const pessimistic = Math.round(probable * 1.8 * 2) / 2;
      await request(`/api/estimates/${encodeURIComponent(task.id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ optimistic, probable, pessimistic })
      });
    }
  }

  console.log(`Projet de démonstration ajouté (${index} tâches estimées) sur ${baseUrl}.`);
}

main().catch(error => {
  console.error(`Échec du remplissage : ${error.message}`);
  process.exitCode = 1;
});
