function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateRandomProfile(): { name: string; birthdate: string } {
  const firstNames = [
    "Alex",
    "Chris",
    "Jordan",
    "Taylor",
    "Sam",
    "Morgan",
    "Casey",
    "Riley",
    "Avery",
    "Jamie",
  ];
  const lastNames = [
    "Smith",
    "Johnson",
    "Brown",
    "Davis",
    "Miller",
    "Wilson",
    "Moore",
    "Clark",
    "Lee",
    "Walker",
  ];

  const first = firstNames[randomInt(0, firstNames.length - 1)];
  const last = lastNames[randomInt(0, lastNames.length - 1)];
  const name = `${first} ${last}`;
  const year = randomInt(1988, 2004);
  const month = randomInt(1, 12);
  const maxDay = new Date(year, month, 0).getDate();
  const day = randomInt(1, maxDay);
  const birthdate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return { name, birthdate };
}
