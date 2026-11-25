const DUPLICATE_MESSAGES = {
  contact_no: 'Contact number is already registered to another client.',
  email: 'Email address is already registered to another client.'
};

const DUPLICATE_CONSTRAINT_FIELDS = {
  uq_clients_contact_no_normalized: 'contact_no',
  uq_clients_email_normalized: 'email'
};

function duplicateClientError(field) {
  const error = new Error(DUPLICATE_MESSAGES[field]);
  error.status = 409;
  error.duplicateField = field;
  return error;
}

function duplicateClientMessage(error) {
  if (!error) return null;
  const field = error.duplicateField || DUPLICATE_CONSTRAINT_FIELDS[error.constraint];
  if (field && DUPLICATE_MESSAGES[field]) return DUPLICATE_MESSAGES[field];
  if (error.code === '23505') return 'A client with this contact number or email address already exists.';
  return null;
}

module.exports = { duplicateClientError, duplicateClientMessage };
