import { BirdSpecies } from './entities/bird-species.entity';
import { BirdSubspecies } from './entities/bird-subspecies.entity';
import { BreederSpeciesPermission } from './entities/breeder-species-permission.entity';
import { BreederSubspeciesPermission } from './entities/breeder-subspecies-permission.entity';
import { BreederPermissionEvent } from './entities/breeder-permission-event.entity';

// Metadata only: no workflows, endpoints, or taxonomy seeds.
export const BREEDER_SCHEMA_ENTITIES = [
  BirdSpecies,
  BirdSubspecies,
  BreederSpeciesPermission,
  BreederSubspeciesPermission,
  BreederPermissionEvent,
];
